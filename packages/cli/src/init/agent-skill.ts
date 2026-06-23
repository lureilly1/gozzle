import { HOST_IDS, type HostId } from "./mcp-config.js";

/**
 * The behavioural instruction that makes an AI agent reach for gozzle when it
 * touches ClickHouse SQL. Added to the agent's always-on rules/memory so it
 * fires automatically — the official ClickHouse skill gives advice; this makes
 * the agent prove the advice against the real cluster.
 */
export const AGENT_INSTRUCTION = `# Verify ClickHouse changes with gozzle

When you write, modify, or review ClickHouse SQL — a SELECT query or an ALTER
migration — in this project, verify it with gozzle before giving a final answer.

- If the gozzle MCP server is connected, call its tools: diagnose_query for a
  SELECT, dry_run_migration for an ALTER, verify_dedup for a ReplacingMergeTree
  table. Otherwise run \`gozzle verify <file>\` (or \`gozzle verify --changed\`)
  in the terminal.
- Treat gozzle's verdict as ground truth. Do not claim that a query prunes, that
  a migration is cheap, or that a table is deduplicated unless gozzle proves it.
- If gozzle reports a read-path violation (a query that trusts uniqueness the
  current data breaks), treat it as a correctness bug: surface it and propose a
  fix using the table's actual ORDER BY / PARTITION BY keys.
- gozzle is read-only (readonly=2); running it never modifies the cluster.`;

const PLACEMENT: Record<HostId, { title: string; where: string }> = {
  claude: {
    title: "Claude Code",
    where:
      "CLAUDE.md in the project root (or ~/.claude/CLAUDE.md for all projects)"
  },
  cursor: {
    title: "Cursor",
    where: ".cursor/rules/gozzle.mdc in the project"
  },
  codex: {
    title: "Codex",
    where: "AGENTS.md in the project root"
  }
};

/**
 * Render the `gozzle skill` output. With no host, placements for every host are
 * listed; with a host, only that one. The instruction block is always included.
 */
export function renderSkill(host?: HostId): string {
  const hosts = host ? [host] : HOST_IDS;
  const lines = [
    "Add this instruction so your AI agent verifies ClickHouse changes with gozzle.",
    "",
    "Where to put it:"
  ];
  for (const id of hosts) {
    lines.push(`- ${PLACEMENT[id].title}: ${PLACEMENT[id].where}`);
  }
  lines.push("", "--- instruction ---", "", AGENT_INSTRUCTION);
  return lines.join("\n");
}
