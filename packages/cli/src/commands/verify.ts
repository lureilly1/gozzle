import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { diagnoseQuery, type DiagnoseQueryResult } from "../clickhouse/query-diagnosis.js";
import { dryRunMigration } from "../clickhouse/migration.js";
import { verifyDedup } from "../clickhouse/dedup.js";
import {
  detectStatementKind,
  stripSqlComments,
  type StatementKind
} from "../clickhouse/statement.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import {
  matchesAnyGlob,
  readProjectConfig,
  type GozzleProjectConfig,
  type TableAssumption
} from "../config/project.js";
import { formatQueryDiagnosis } from "../tools/diagnose-query.js";
import { formatMigrationResult, } from "../tools/dry-run-migration.js";
import { readDedupScanGuard } from "../tools/verify-dedup.js";
import { formatCount } from "../shared/format.js";
import { recordAudit } from "../shared/audit.js";

export interface ReadPathOutcome {
  table: string;
  uniqueBy: string[];
  status: "violated" | "clean" | "unknown";
  duplicateRows: number;
  message: string;
}

const execFileAsync = promisify(execFile);

export interface VerifyOptions {
  strict: boolean;
  json: boolean;
  changed: boolean;
  diff?: string;
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
  const options: VerifyOptions = { strict: false, json: false, changed: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--diff") {
      const range = argv[i + 1];
      if (!range || range.startsWith("--")) {
        return { files, options, error: "--diff requires a git range, e.g. origin/main...HEAD" };
      }
      options.diff = range;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { files, options, error: `Unknown flag: ${arg}` };
    } else {
      files.push(arg);
    }
  }

  return { files, options };
}

/**
 * Filter a list of paths to the ones gozzle should verify: those matching the
 * configured query/migration globs, or — with no config — any `.sql` file.
 */
export function selectVerifiableFiles(
  files: string[],
  config?: GozzleProjectConfig
): string[] {
  const globs = config ? [...config.queries, ...config.migrations] : [];
  return files.filter((file) =>
    globs.length > 0
      ? matchesAnyGlob(file, globs)
      : file.replaceAll("\\", "/").endsWith(".sql")
  );
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
  env: NodeJS.ProcessEnv = process.env,
  config?: GozzleProjectConfig
): Promise<FileOutcome[]> {
  const outcomes: FileOutcome[] = [];
  for (const file of files) {
    outcomes.push(
      await verifyFile(client, file, defaultDatabase, options, env, config)
    );
  }
  return outcomes;
}

async function verifyFile(
  client: ClickHouseMetadataClient,
  file: string,
  defaultDatabase: string,
  options: VerifyOptions,
  env: NodeJS.ProcessEnv,
  config?: GozzleProjectConfig
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
      const readPaths = await checkReadPaths(
        client,
        result,
        config,
        defaultDatabase,
        env
      );
      const proven = result.findings.filter((f) => f.confidence === "proven");
      const advisory = result.findings.filter((f) => f.confidence === "advisory");
      const violated = readPaths.some((r) => r.status === "violated");
      const failing =
        proven.length > 0 || violated || (options.strict && advisory.length > 0);
      await audit(env, file, "ok", start);
      return {
        file,
        kind,
        label: "SELECT",
        failing,
        errored: false,
        text: [formatQueryDiagnosis(result), formatReadPaths(readPaths)]
          .filter(Boolean)
          .join("\n\n"),
        json: {
          file,
          kind,
          failing,
          findings: result.findings,
          readPaths
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
  const { files: argFiles, options, error } = parseVerifyArgs(argv);
  if (error) {
    console.error(error);
    return 2;
  }

  let project: GozzleProjectConfig | undefined;
  try {
    project = (await readProjectConfig())?.config;
  } catch (configError) {
    console.error(message(configError));
    return 2;
  }

  let targetFiles = argFiles;
  if (options.changed || options.diff) {
    try {
      targetFiles = await resolveGitFiles(options, project);
    } catch (gitError) {
      console.error(
        `gozzle verify could not resolve changed files.\n\n${message(gitError)}`
      );
      return 2;
    }
    if (targetFiles.length === 0) {
      console.log("No changed ClickHouse files to verify.");
      return 0;
    }
  } else if (argFiles.length === 0) {
    console.error(
      "Usage: gozzle verify <file ...> | --changed | --diff <range> [--strict] [--json]"
    );
    return 2;
  }

  let client: ClickHouseHttpMetadataClient | undefined;
  try {
    const config = readClickHouseConfig(env);
    client = new ClickHouseHttpMetadataClient(config);
    const outcomes = await verifyFiles(
      client,
      targetFiles,
      config.database ?? project?.database ?? "default",
      options,
      env,
      project
    );
    console.log(options.json ? renderJson(outcomes) : renderHuman(outcomes));
    return aggregateExitCode(outcomes);
  } catch (runError) {
    console.error(`gozzle verify could not run.\n\n${message(runError)}`);
    return 2;
  } finally {
    await client?.close();
  }
}

/** Resolve the changed/diffed files git reports, filtered to verifiable SQL. */
async function resolveGitFiles(
  options: VerifyOptions,
  project: GozzleProjectConfig | undefined
): Promise<string[]> {
  const root = (await gitLines(["rev-parse", "--show-toplevel"]))[0];
  if (!root) throw new Error("not inside a git repository.");

  let changed: string[];
  if (options.diff) {
    changed = await gitLines(["diff", "--name-only", options.diff]);
  } else {
    const tracked = await gitLines(["diff", "--name-only", "HEAD"]);
    const untracked = await gitLines([
      "ls-files",
      "--others",
      "--exclude-standard"
    ]);
    changed = [...new Set([...tracked, ...untracked])];
  }

  return selectVerifiableFiles(changed, project)
    .map((file) => join(root, file))
    .filter((file) => existsSync(file));
}

async function gitLines(args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The read-path proof: for each table the query reads that is declared unique
 * (gozzle.yaml assumptions) and is read without FINAL, check whether current
 * data actually violates that uniqueness — turning "duplicates exist" into
 * "this query can overcount."
 */
export async function checkReadPaths(
  client: ClickHouseMetadataClient,
  result: DiagnoseQueryResult,
  config: GozzleProjectConfig | undefined,
  defaultDatabase: string,
  env: NodeJS.ProcessEnv
): Promise<ReadPathOutcome[]> {
  if (!config || result.query.hasFinal) return [];

  const guard = readDedupScanGuard(env);
  const outcomes: ReadPathOutcome[] = [];
  for (const table of result.explain.tables) {
    const assumption = findAssumption(config, table.table);
    if (!assumption?.uniqueBy || assumption.uniqueBy.length === 0) continue;

    let dedup;
    try {
      dedup = await verifyDedup(client, {
        table: table.table,
        defaultDatabase,
        maxScanRows: guard.maxScanRows,
        maxScanBytes: guard.maxScanBytes
      });
    } catch {
      continue; // cannot prove this table; leave it out rather than guess
    }
    if (!dedup.eligible) continue;

    const keys = assumption.uniqueBy.join(", ");
    if (dedup.scanSkipped) {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "unknown",
        duplicateRows: 0,
        message: `${table.table} is too large to confirm; it is declared unique by (${keys}) and read without FINAL.`
      });
    } else if (dedup.finalCollapsibleRows > 0) {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "violated",
        duplicateRows: dedup.finalCollapsibleRows,
        message: `${table.table} is read without FINAL and trusted as unique by (${keys}), but currently has ${formatCount(dedup.finalCollapsibleRows)} duplicate row(s) by sorting key — this query can overcount.`
      });
    } else {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "clean",
        duplicateRows: 0,
        message: `${table.table} is declared unique by (${keys}) and currently has no duplicates.`
      });
    }
  }
  return outcomes;
}

function findAssumption(
  config: GozzleProjectConfig,
  explainTable: string
): TableAssumption | undefined {
  if (config.assumptions[explainTable]) return config.assumptions[explainTable];
  const bare = explainTable.includes(".")
    ? explainTable.slice(explainTable.lastIndexOf(".") + 1)
    : explainTable;
  return config.assumptions[bare];
}

export function formatReadPaths(items: ReadPathOutcome[]): string {
  if (items.length === 0) return "";
  return ["Read-path proof:", ...items.map((it) => `- [${it.status}] ${it.message}`)].join(
    "\n"
  );
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
