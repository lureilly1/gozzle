import {
  ClickHouseLogLevel,
  createClient,
  type ClickHouseClient
} from "@clickhouse/client";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

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

export interface ExportLimits {
  maxRows: number;
  maxBytes: number;
}

export interface ClickHouseExportClient extends ClickHouseMetadataClient {
  exportParquet(
    query: string,
    destination: string,
    limits: ExportLimits
  ): Promise<{ bytesWritten: number }>;
}

export class ClickHouseHttpMetadataClient implements ClickHouseExportClient {
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
      clickhouse_settings: this.settings,
      // Probe failures are expected evidence (e.g. a cast that cannot hold);
      // gozzle reports them itself, so keep the client's own logging quiet.
      log: { level: ClickHouseLogLevel.OFF }
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

  async exportParquet(
    query: string,
    destination: string,
    limits: ExportLimits
  ): Promise<{ bytesWritten: number }> {
    const normalizedQuery = query.trim().replace(/;$/, "");
    const result = await this.client.exec({
      query: `${normalizedQuery}\nFORMAT Parquet`,
      clickhouse_settings: {
        ...this.settings,
        max_result_rows: String(limits.maxRows),
        result_overflow_mode: "throw",
        max_rows_to_read: String(limits.maxRows),
        max_bytes_to_read: String(limits.maxBytes),
        read_overflow_mode: "throw"
      }
    });

    await pipeline(
      result.stream,
      createWriteStream(destination, { flags: "wx", mode: 0o600 })
    );
    const file = await stat(destination);
    return { bytesWritten: file.size };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
