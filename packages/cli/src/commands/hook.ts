import { existsSync } from "node:fs";

import { withClickHouseClient } from "../clickhouse/with-client.js";
import { readProjectConfig } from "../config/project.js";
import { aggregateExitCode, renderHuman, verifyFiles } from "./verify.js";

/**
 * Pull editable .sql file paths out of a PostToolUse payload. Returns only paths
 * that exist on disk and end in .sql, so non-SQL edits are a no-op.
 */
export function extractSqlPaths(rawPayload: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return [];
  }
  const input = (payload as { tool_input?: Record<string, unknown> })
    ?.tool_input;
  if (!input) return [];

  const candidates: string[] = [];
  if (typeof input.file_path === "string") candidates.push(input.file_path);
  else if (typeof input.path === "string") candidates.push(input.path);

  return candidates.filter(
    (path) => path.toLowerCase().endsWith(".sql") && existsSync(path)
  );
}

/**
 * The hook runtime invoked by the agent harness ("gozzle hook run"). Reads a
 * PostToolUse payload from stdin, verifies any edited .sql file, and, on
 * findings, exits 2 with the verdict on stderr so the agent must address it.
 * Anything else (non-SQL edit, no connection, gozzle's own error) exits 0: the
 * hook never disrupts the agent over gozzle's setup.
 */
export async function runHookRun(
  options: { input?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<number> {
  const env = options.env ?? process.env;
  const raw = options.input ?? (await readStdin());
  const paths = extractSqlPaths(raw);
  if (paths.length === 0) return 0;

  try {
    return await withClickHouseClient(async (client, config) => {
      const project = (await readProjectConfig().catch(() => undefined))
        ?.config;
      const outcomes = await verifyFiles(
        client,
        paths,
        config.database ?? project?.database ?? "default",
        { strict: false, json: false, changed: false, all: false },
        env,
        project
      );
      if (aggregateExitCode(outcomes) === 1) {
        process.stderr.write(`${renderHuman(outcomes)}\n`);
        return 2; // findings → block; stderr is shown to the agent
      }
      return 0;
    }, env);
  } catch {
    return 0; // never break the agent's flow over gozzle's own issue
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
