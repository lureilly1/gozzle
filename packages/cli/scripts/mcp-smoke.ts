import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/src/mcp/server.js"]
});

const client = new Client({
  name: "@gozzle/smoke-test",
  version: "0.0.0"
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const hasHealthTool = tools.tools.some((tool) => tool.name === "health");
  const hasConnectTool = tools.tools.some((tool) => tool.name === "connect");
  const hasInspectTableTool = tools.tools.some(
    (tool) => tool.name === "inspect_table"
  );
  const hasVerifyDedupTool = tools.tools.some(
    (tool) => tool.name === "verify_dedup"
  );

  if (!hasHealthTool) {
    throw new Error("Expected MCP server to expose a health tool.");
  }

  if (!hasConnectTool) {
    throw new Error("Expected MCP server to expose a connect tool.");
  }

  if (!hasInspectTableTool) {
    throw new Error("Expected MCP server to expose an inspect_table tool.");
  }

  if (!hasVerifyDedupTool) {
    throw new Error("Expected MCP server to expose a verify_dedup tool.");
  }

  const result = await client.callTool({
    name: "health",
    arguments: {}
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
