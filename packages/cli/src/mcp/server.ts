#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

// Resolve the entry path through symlinks: npm global bins (e.g. `gozzle-mcp`)
// and how Claude Code launches MCP servers invoke this file via a symlink, so
// process.argv[1] is the symlink while import.meta.url is the realpath.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  startMcpServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
