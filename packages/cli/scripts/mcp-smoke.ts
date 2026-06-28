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
  const hasVerifyArtifactTool = tools.tools.some(
    (tool) => tool.name === "verify_artifact"
  );
  const hasVerifyDedupTool = tools.tools.some(
    (tool) => tool.name === "verify_dedup"
  );
  const hasCreateLocalSliceTool = tools.tools.some(
    (tool) => tool.name === "create_local_slice"
  );
  const hasDryRunMigrationTool = tools.tools.some(
    (tool) => tool.name === "dry_run_migration"
  );
  const hasDiagnoseQueryTool = tools.tools.some(
    (tool) => tool.name === "diagnose_query"
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

  if (!hasVerifyArtifactTool) {
    throw new Error("Expected MCP server to expose a verify_artifact tool.");
  }

  if (!hasVerifyDedupTool) {
    throw new Error("Expected MCP server to expose a verify_dedup tool.");
  }

  if (!hasCreateLocalSliceTool) {
    throw new Error("Expected MCP server to expose a create_local_slice tool.");
  }

  if (!hasDryRunMigrationTool) {
    throw new Error("Expected MCP server to expose a dry_run_migration tool.");
  }

  if (!hasDiagnoseQueryTool) {
    throw new Error("Expected MCP server to expose a diagnose_query tool.");
  }

  const result = await client.callTool({
    name: "health",
    arguments: {}
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
