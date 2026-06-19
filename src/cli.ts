#!/usr/bin/env node

import { readPackageMetadata } from "./shared/package-metadata.js";

const metadata = readPackageMetadata();
const command = process.argv[2] ?? "help";

if (command === "version" || command === "--version" || command === "-v") {
  console.log(metadata.version);
  process.exit(0);
}

if (command === "init") {
  printInit();
  process.exit(0);
}

console.log(`gozzle ${metadata.version}`);
console.log("");
console.log("Commands:");
console.log("  gozzle init        Print MCP config for your AI host");
console.log("  gozzle version     Print the CLI version");
console.log("  gozzle-mcp         Start the MCP stdio server");

function printInit(): void {
  console.log("Add this MCP server config to Claude, Cursor, Codex, or another MCP host:");
  console.log("");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          gozzle: {
            command: "gozzle-mcp",
            env: {
              GOZZLE_CLICKHOUSE_URL: "https://your-cluster.clickhouse.cloud:8443",
              GOZZLE_CLICKHOUSE_USER: "gozzle_readonly",
              GOZZLE_CLICKHOUSE_PASSWORD: "replace-me",
              GOZZLE_CLICKHOUSE_DATABASE: "default"
            }
          }
        }
      },
      null,
      2
    )
  );
  console.log("");
  console.log("Use a read-only ClickHouse user. Gozzle does not need write access.");
}
