import { readFile } from "node:fs/promises";

import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { diagnoseQuery } from "../clickhouse/query-diagnosis.js";
import { dryRunMigration } from "../clickhouse/migration.js";
import {
  detectStatementKind,
  stripSqlComments,
  type StatementKind
} from "../clickhouse/statement.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { formatQueryDiagnosis } from "../tools/diagnose-query.js";
import { formatMigrationResult } from "../tools/dry-run-migration.js";
import { recordAudit } from "../shared/audit.js";

export interface VerifyOptions {
  strict: boolean;
  json: boolean;
}

export interface FileOutcome {
  file: string;
  kind: StatementKind | "error";
  label: string;
  /** Gate failure → contributes to exit code 1. */
  failing: boolean;
  /** Operational error (could not verify) → contributes to exit code 2. */
  errored: boolean;
  text: string;
  json: Record<string, unknown>;
}

export interface ParsedVerifyArgs {
  files: string[];
  options: VerifyOptions;
  error?: string;
}

export function parseVerifyArgs(argv: string[]): ParsedVerifyArgs {
  const files: string[] = [];
  const options: VerifyOptions = { strict: false, json: false };

  for (const arg of argv) {
    if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) return { files, options, error: `Unknown flag: ${arg}` };
    else files.push(arg);
  }

  return { files, options };
}

/**
 * Verify each file against the cluster the client is connected to. Pure of
 * process/IO concerns beyond reading the files, so it is unit-testable with a
 * fake client.
 */
export async function verifyFiles(
  client: ClickHouseMetadataClient,
  files: string[],
  defaultDatabase: string,
  options: VerifyOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<FileOutcome[]> {
  const outcomes: FileOutcome[] = [];
  for (const file of files) {
    outcomes.push(await verifyFile(client, file, defaultDatabase, options, env));
  }
  return outcomes;
}

async function verifyFile(
  client: ClickHouseMetadataClient,
  file: string,
  defaultDatabase: string,
  options: VerifyOptions,
  env: NodeJS.ProcessEnv
): Promise<FileOutcome> {
  const start = Date.now();

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const outcome = operationalError(file, `could not read file: ${message(error)}`);
    await audit(env, file, "error", start);
    return outcome;
  }

  const statement = stripSqlComments(raw).trim().replace(/;\s*$/, "");
  const kind = detectStatementKind(statement);

  try {
    if (kind === "query") {
      const result = await diagnoseQuery(client, statement, defaultDatabase);
      const proven = result.findings.filter((f) => f.confidence === "proven");
      const advisory = result.findings.filter((f) => f.confidence === "advisory");
      const failing = proven.length > 0 || (options.strict && advisory.length > 0);
      await audit(env, file, "ok", start);
      return {
        file,
        kind,
        label: "SELECT",
        failing,
        errored: false,
        text: formatQueryDiagnosis(result),
        json: {
          file,
          kind,
          failing,
          findings: result.findings
        }
      };
    }

    if (kind === "migration") {
      const result = await dryRunMigration(client, {
        statement,
        defaultDatabase
      });
      const classification = result.parsed.classification;
      const failing = classification !== "metadata-only";
      await audit(env, file, "ok", start);
      return {
        file,
        kind,
        label: "ALTER",
        failing,
        errored: false,
        text: formatMigrationResult(result),
        json: {
          file,
          kind,
          failing,
          classification,
          rewrite: result.rewrite
        }
      };
    }

    const outcome = operationalError(
      file,
      "not a SELECT/WITH query or an ALTER statement (one statement per file)."
    );
    await audit(env, file, "error", start);
    return outcome;
  } catch (error) {
    const outcome = operationalError(file, message(error));
    await audit(env, file, "error", start);
    return outcome;
  }
}

function operationalError(file: string, detail: string): FileOutcome {
  return {
    file,
    kind: "error",
    label: "error",
    failing: false,
    errored: true,
    text: detail,
    json: { file, status: "error", error: detail }
  };
}

export function aggregateExitCode(outcomes: FileOutcome[]): number {
  if (outcomes.some((o) => o.errored)) return 2;
  if (outcomes.some((o) => o.failing)) return 1;
  return 0;
}

export function renderHuman(outcomes: FileOutcome[]): string {
  const blocks = outcomes.map(
    (o) => `▸ ${o.file}  (${o.label})\n${o.text}`
  );
  const failed = outcomes.filter((o) => o.failing || o.errored).length;
  const mark = failed === 0 ? "✓" : "✗";
  blocks.push(
    `Summary: ${failed} of ${outcomes.length} file(s) have findings or errors. ${mark}`
  );
  return blocks.join("\n\n");
}

export function renderJson(outcomes: FileOutcome[]): string {
  return JSON.stringify(
    outcomes.map((o) => o.json),
    null,
    2
  );
}

export async function runVerifyCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const { files, options, error } = parseVerifyArgs(argv);
  if (error) {
    console.error(error);
    return 2;
  }
  if (files.length === 0) {
    console.error("Usage: gozzle verify <file> [<file> ...] [--strict] [--json]");
    return 2;
  }

  let client: ClickHouseHttpMetadataClient | undefined;
  try {
    const config = readClickHouseConfig(env);
    client = new ClickHouseHttpMetadataClient(config);
    const outcomes = await verifyFiles(
      client,
      files,
      config.database ?? "default",
      options,
      env
    );
    console.log(options.json ? renderJson(outcomes) : renderHuman(outcomes));
    return aggregateExitCode(outcomes);
  } catch (error) {
    console.error(`gozzle verify could not run.\n\n${message(error)}`);
    return 2;
  } finally {
    await client?.close();
  }
}

async function audit(
  env: NodeJS.ProcessEnv,
  file: string,
  outcome: "ok" | "error",
  start: number
): Promise<void> {
  await recordAudit(
    {
      timestamp: new Date().toISOString(),
      tool: "verify",
      arguments: { file },
      outcome,
      durationMs: Date.now() - start
    },
    env
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
