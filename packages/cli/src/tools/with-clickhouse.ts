import type { ClickHouseExportClient } from "../clickhouse/client.js";
import type { ClickHouseConnectionConfig } from "../config/clickhouse.js";
import { withClickHouseClient } from "../clickhouse/with-client.js";

/**
 * The text-result shape gozzle MCP tools return. A `type` alias (not an
 * interface) so it gets an implicit index signature and stays assignable to the
 * MCP SDK's `CallToolResult`, whose schema is loose/passthrough.
 */
export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

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
