#!/usr/bin/env node

import { readPackageMetadata } from "./shared/package-metadata.js";
import { readLocalSliceConfig } from "./config/local-slice.js";
import {
  cleanLocalSlices,
  listLocalSlices
} from "./local-engine/slice-store.js";
import { isHostId, renderInit } from "./init/mcp-config.js";
import { renderSkill } from "./init/agent-skill.js";
import { runVerifyCommand } from "./commands/verify.js";
import { runDiscoverCommand } from "./commands/discover.js";
import { runEquivalentCommand } from "./commands/equivalent.js";
import { runHookRun } from "./commands/hook.js";
import { renderHookRecipe } from "./init/hook-recipe.js";
import { formatBytes } from "./shared/format.js";

const metadata = readPackageMetadata();

interface Command {
  /** Left column in the help listing, after "gozzle ". */
  usage: string;
  summary: string;
  /** Returns the process exit code. */
  run: (args: string[]) => Promise<number> | number;
}

const commands: Record<string, Command> = {
  verify: {
    usage: "verify",
    summary:
      "Verify SQL files | --changed | --diff <range> | --all (exit 1 on findings)",
    run: (args) => runVerifyCommand(args)
  },
  discover: {
    usage: "discover",
    summary:
      "Rank recent SELECTs from system.query_log (--since 7d, --limit N)",
    run: (args) => runDiscoverCommand(args)
  },
  equivalent: {
    usage: "equivalent <a.sql> <b.sql>",
    summary: "Prove two queries return the same result",
    run: (args) => runEquivalentCommand(args)
  },
  init: {
    usage: "init [host]",
    summary:
      "Print MCP config (host: claude, cursor, codex; --local for project install)",
    run: (args) => {
      const local = args.includes("--local");
      const host = args.find((arg) => !arg.startsWith("--"));
      if (host !== undefined && !isHostId(host)) {
        fail("Usage: gozzle init [claude|cursor|codex] [--local]");
      }
      console.log(renderInit(host, undefined, local));
      return 0;
    }
  },
  skill: {
    usage: "skill [host]",
    summary: "Print the agent instruction to auto-verify ClickHouse changes",
    run: (args) => {
      const host = args[0];
      if (host !== undefined && !isHostId(host)) {
        fail("Usage: gozzle skill [claude|cursor|codex]");
      }
      console.log(renderSkill(host));
      return 0;
    }
  },
  hook: {
    usage: "hook",
    summary:
      "Print the PostToolUse hook recipe (gozzle hook run = the runtime)",
    run: (args) => {
      if (args[0] === "run") return runHookRun();
      console.log(renderHookRecipe(args.includes("--local")));
      return 0;
    }
  },
  slices: {
    usage: "slices",
    summary: "List and clean local slice workspaces",
    run: async (args) => {
      await runSlicesCommand(args);
      return 0;
    }
  },
  version: {
    usage: "version",
    summary: "Print the CLI version",
    run: () => {
      console.log(metadata.version);
      return 0;
    }
  }
};

const VERSION_ALIASES = new Set(["version", "--version", "-v"]);
const HELP_ALIASES = new Set(["help", "--help", "-h"]);

const requested = process.argv[2] ?? "help";
const name = VERSION_ALIASES.has(requested) ? "version" : requested;
const command = commands[name];

if (command && !HELP_ALIASES.has(requested)) {
  process.exit(await command.run(process.argv.slice(3)));
}

printHelp();
process.exit(HELP_ALIASES.has(requested) || requested === "help" ? 0 : 1);

function printHelp(): void {
  const width = Math.max(
    ...Object.values(commands).map((c) => c.usage.length),
    "gozzle-mcp".length - "gozzle ".length
  );
  console.log(`gozzle ${metadata.version}`);
  console.log("");
  console.log("Commands:");
  for (const c of Object.values(commands)) {
    console.log(`  gozzle ${c.usage.padEnd(width)}  ${c.summary}`);
  }
  console.log(
    `  ${"gozzle-mcp".padEnd(width + "gozzle ".length)}  Start the MCP stdio server`
  );
}

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
            : (slice.detail ?? "-")
        ].join("\t")
      );
    }
    const total = slices.reduce((bytes, slice) => bytes + slice.sizeBytes, 0);
    console.log(
      `Total: ${formatBytes(total)} in ${slices.length} workspace(s)`
    );
    return;
  }
  if (action === "clean") {
    const targets = args.slice(1);
    if (targets.length === 0) fail(slicesUsage());
    const result = await cleanLocalSlices(
      config.rootDirectory,
      cleanOptions(targets)
    );
    for (const slice of result.removed) console.log(`Removed ${slice.id}`);
    if (result.removed.length === 0 && result.missing.length === 0)
      console.log("No local slices to remove.");
    if (result.missing.length > 0)
      fail(
        `Slice not found or cleanup mode not permitted for its state: ${result.missing.join(", ")}`
      );
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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
