import { createClient, type ClickHouseClient } from "@clickhouse/client";

import type { ClickHouseConnectionConfig } from "../config/clickhouse.js";
import {
  readGuardrailConfig,
  toClickHouseSettings,
  type GuardrailConfig
} from "../config/guardrails.js";

export interface ClickHouseMetadataClient {
  ping(): Promise<boolean>;
  queryJson<T>(query: string): Promise<T[]>;
  close(): Promise<void>;
}

export class ClickHouseHttpMetadataClient implements ClickHouseMetadataClient {
  private readonly client: ClickHouseClient;
  private readonly settings: Record<string, string>;

  constructor(
    config: ClickHouseConnectionConfig,
    guardrails: GuardrailConfig = readGuardrailConfig()
  ) {
    this.settings = toClickHouseSettings(guardrails);
    this.client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      // Apply read-only + cost guardrails to every statement on this client.
      clickhouse_settings: this.settings
    });
  }

  async ping(): Promise<boolean> {
    const result = await this.client.ping();
    return result.success;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    const resultSet = await this.client.query({
      query,
      format: "JSONEachRow",
      clickhouse_settings: this.settings
    });

    return (await resultSet.json()) as T[];
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
