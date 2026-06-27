import {
  ClickHouseHttpMetadataClient,
  type ClickHouseExportClient
} from "./client.js";
import {
  readClickHouseConfig,
  type ClickHouseConnectionConfig
} from "../config/clickhouse.js";

/**
 * Open a read-only ClickHouse client, run `body`, and always close it, the one
 * place that owns the connect/try-finally/close lifecycle. The concrete client
 * satisfies both the metadata and export interfaces, so callers can narrow to
 * whichever they need. Errors propagate; callers decide how to handle them.
 */
export async function withClickHouseClient<T>(
  body: (
    client: ClickHouseExportClient,
    config: ClickHouseConnectionConfig
  ) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  const config = readClickHouseConfig(env);
  const client = new ClickHouseHttpMetadataClient(config);
  try {
    return await body(client, config);
  } finally {
    await client.close();
  }
}
