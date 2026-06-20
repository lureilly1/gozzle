#!/usr/bin/env node

import { readPackageMetadata } from "./shared/package-metadata.js";
import { readLocalSliceConfig } from "./config/local-slice.js";
import { cleanLocalSlices, listLocalSlices } from "./local-engine/slice-store.js";

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

if (command === "slices") {
  await runSlicesCommand(process.argv.slice(3));
  process.exit(0);
}

console.log(`gozzle ${metadata.version}`);
console.log("");
console.log("Commands:");
console.log("  gozzle init        Print MCP config for your AI host");
console.log("  gozzle slices      List and clean local slice workspaces");
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

async function runSlicesCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "list";
  const config = readLocalSliceConfig();
  if (action === "list") {
    const slices = await listLocalSlices(config.rootDirectory);
    if (slices.length === 0) {
      console.log(`No local slices in ${config.rootDirectory}`);
      return;
    }
    for (const slice of slices) {
      const manifest = slice.manifest;
      console.log([
        slice.id,
        manifest.createdAt,
        manifest.source.table,
        `partition=${manifest.source.partitionId}`,
        `data=${formatBytes(manifest.local.dataBytes)}`,
        manifest.proof.matched ? "verified" : "proof-mismatch"
      ].join("\t"));
    }
    return;
  }
  if (action === "clean") {
    const targets = args.slice(1);
    if (targets.length === 0) fail("Usage: gozzle slices clean <slice-id> [...] | --all");
    if (targets.includes("--all") && targets.length !== 1) fail("--all cannot be combined with slice IDs.");
    const result = await cleanLocalSlices(
      config.rootDirectory,
      targets[0] === "--all" ? "all" : targets
    );
    for (const slice of result.removed) console.log(`Removed ${slice.id}`);
    if (result.removed.length === 0 && result.missing.length === 0) console.log("No local slices to remove.");
    if (result.missing.length > 0) fail(`Slice not found: ${result.missing.join(", ")}`);
    return;
  }
  fail("Usage: gozzle slices [list] | clean <slice-id> [...] | clean --all");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
