import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createHealthTool(server: McpServer): void {
  server.registerTool(
    "health",
    {
      title: "Health Check",
      description: "Confirm the Gozzle MCP server is running.",
      inputSchema: {}
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Gozzle MCP server is running."
        }
      ]
    })
  );
}

