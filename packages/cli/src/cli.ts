#!/usr/bin/env node

import { readPackageMetadata } from "./shared/package-metadata.js";
import { readLocalSliceConfig } from "./config/local-slice.js";
import { cleanLocalSlices, listLocalSlices } from "./local-engine/slice-store.js";
import { isHostId, renderInit } from "./init/mcp-config.js";
import { renderSkill } from "./init/agent-skill.js";
import { runVerifyCommand } from "./commands/verify.js";

const metadata = readPackageMetadata();
const command = process.argv[2] ?? "help";

if (command === "version" || command === "--version" || command === "-v") {
  console.log(metadata.version);
  process.exit(0);
}

if (command === "init") {
  const args = process.argv.slice(3);
  const local = args.includes("--local");
  const host = args.find((arg) => !arg.startsWith("--"));
  if (host !== undefined && !isHostId(host)) {
    fail("Usage: gozzle init [claude|cursor|codex] [--local]");
  }
  console.log(renderInit(host, undefined, local));
  process.exit(0);
}

if (command === "skill") {
  const host = process.argv[3];
  if (host !== undefined && !isHostId(host)) {
    fail("Usage: gozzle skill [claude|cursor|codex]");
  }
  console.log(renderSkill(host));
  process.exit(0);
}

if (command === "verify") {
  const code = await runVerifyCommand(process.argv.slice(3));
  process.exit(code);
}

if (command === "slices") {
  await runSlicesCommand(process.argv.slice(3));
  process.exit(0);
}

console.log(`gozzle ${metadata.version}`);
console.log("");
console.log("Commands:");
console.log("  gozzle verify        Verify SQL files | --changed | --diff <range> | --all (exit 1 on findings)");
console.log("  gozzle init [host] Print MCP config (host: claude, cursor, codex; --local for project install)");
console.log("  gozzle skill [host] Print the agent instruction to auto-verify ClickHouse changes");
console.log("  gozzle slices      List and clean local slice workspaces");
console.log("  gozzle version     Print the CLI version");
console.log("  gozzle-mcp         Start the MCP stdio server");

async function runSlicesCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "list";
  const config = readLocalSliceConfig();
  if (action === "list") {
    if (args.length > 1) fail(slicesUsage());
    const slices = await listLocalSlices(config.rootDirectory);
    if (slices.length === 0) {
      console.log(`No local slices in ${config.rootDirectory}`);
      return;
    }
    console.log(
      "WARNING: Local slices contain production data and persist until explicitly cleaned."
    );
    for (const slice of slices) {
      const manifest = slice.manifest;
      console.log(
        [
          slice.id,
          slice.state,
          manifest?.createdAt ?? slice.modifiedAt,
          manifest?.source.table ?? "-",
          manifest ? `partition=${manifest.source.partitionId}` : "partition=-",
          `size=${formatBytes(slice.sizeBytes)}`,
          manifest
            ? manifest.proof.matched
              ? "verified"
              : "proof-mismatch"
            : slice.detail ?? "-"
        ].join("\t")
      );
    }
    const total = slices.reduce((bytes, slice) => bytes + slice.sizeBytes, 0);
    console.log(`Total: ${formatBytes(total)} in ${slices.length} workspace(s)`);
    return;
  }
  if (action === "clean") {
    const targets = args.slice(1);
    if (targets.length === 0) fail(slicesUsage());
    const result = await cleanLocalSlices(config.rootDirectory, cleanOptions(targets));
    for (const slice of result.removed) console.log(`Removed ${slice.id}`);
    if (result.removed.length === 0 && result.missing.length === 0) console.log("No local slices to remove.");
    if (result.missing.length > 0) fail(`Slice not found or cleanup mode not permitted for its state: ${result.missing.join(", ")}`);
    const remaining = await listLocalSlices(config.rootDirectory);
    const remainingBytes = remaining.reduce(
      (bytes, slice) => bytes + slice.sizeBytes,
      0
    );
    console.log(
      `Freed ${formatBytes(result.bytesFreed)}; remaining ${formatBytes(remainingBytes)}`
    );
    return;
  }
  fail(slicesUsage());
}

function cleanOptions(targets: string[]) {
  if (targets[0] === "--all" && targets.length === 1) return { all: true };
  if (targets[0] === "--invalid") {
    if (targets.slice(1).some((target) => target.startsWith("--"))) {
      fail(slicesUsage());
    }
    return { invalid: true, ids: targets.slice(1) };
  }
  if (targets[0] === "--older-than" && targets.length === 2) {
    const match = /^(\d+)d$/.exec(targets[1]);
    if (!match || Number(match[1]) < 1) {
      fail("--older-than requires a positive whole-day duration such as 7d.");
    }
    return { olderThanMs: Number(match[1]) * 24 * 60 * 60 * 1000 };
  }
  if (targets.some((target) => target.startsWith("--"))) fail(slicesUsage());
  return { ids: targets };
}

function slicesUsage(): string {
  return "Usage: gozzle slices [list] | clean <slice-id> [...] | clean --all | clean --older-than 7d | clean --invalid [slice-id ...]";
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
