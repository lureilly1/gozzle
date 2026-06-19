#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createConnectTool } from "../tools/connect.js";
import { createHealthTool } from "../tools/health.js";
import { createInspectTableTool } from "../tools/inspect-table.js";
import { readPackageMetadata } from "../shared/package-metadata.js";

export function createGozzleMcpServer(): McpServer {
  const metadata = readPackageMetadata();
  const server = new McpServer({
    name: "@gozzle/cli",
    version: metadata.version
  });

  createHealthTool(server);
  createConnectTool(server);
  createInspectTableTool(server);

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createGozzleMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
