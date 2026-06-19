import { createClient, type ClickHouseClient } from "@clickhouse/client";

import type { ClickHouseConnectionConfig } from "../config/clickhouse.js";

export interface ClickHouseMetadataClient {
  ping(): Promise<boolean>;
  queryJson<T>(query: string): Promise<T[]>;
  close(): Promise<void>;
}

export class ClickHouseHttpMetadataClient implements ClickHouseMetadataClient {
  private readonly client: ClickHouseClient;

  constructor(config: ClickHouseConnectionConfig) {
    this.client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database
    });
  }

  async ping(): Promise<boolean> {
    const result = await this.client.ping();
    return result.success;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    const resultSet = await this.client.query({
      query,
      format: "JSONEachRow"
    });

    return (await resultSet.json()) as T[];
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

