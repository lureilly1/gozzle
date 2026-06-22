import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runAuditedTool } from "../shared/audit.js";

export function createHealthTool(server: McpServer): void {
  server.registerTool(
    "health",
    {
      title: "Health Check",
      description: "Confirm the gozzle MCP server is running.",
      inputSchema: {}
    },
    async () =>
      runAuditedTool("health", {}, async () => ({
        content: [
          {
            type: "text",
            text: "gozzle MCP server is running."
          }
        ]
      }))
  );
}

