import type { ClickHouseExportClient } from "../clickhouse/client.js";
import type { ClickHouseConnectionConfig } from "../config/clickhouse.js";
import { withClickHouseClient } from "../clickhouse/with-client.js";

/** The text-result shape gozzle MCP tools return. The index signature keeps it
 *  assignable to the MCP SDK's CallToolResult. */
export interface ToolTextResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Connect read-only, run `body`, and always close — turning any thrown error
 * into an `isError` tool result via `formatError`. Removes the connect/close/
 * try-finally boilerplate every ClickHouse-backed tool would otherwise repeat.
 */
export async function withClickHouseTool(
  body: (
    client: ClickHouseExportClient,
    config: ClickHouseConnectionConfig
  ) => Promise<ToolTextResult>,
  formatError: (error: unknown) => string
): Promise<ToolTextResult> {
  try {
    return await withClickHouseClient(body);
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: formatError(error) }]
    };
  }
}
