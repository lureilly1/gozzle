import { dirname } from "node:path";
import { readFile } from "node:fs/promises";

import { errorMessage } from "../shared/errors.js";
import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import { withClickHouseClient } from "../clickhouse/with-client.js";
import type { StatementKind } from "../clickhouse/statement.js";
import {
  readProjectConfig,
  type GozzleProjectConfig
} from "../config/project.js";
import { recordAudit } from "../shared/audit.js";
import type { VerificationRun } from "../shared/verdict.js";
import { verifyArtifact } from "../planner/planner.js";
import { classifyArtifact } from "../planner/artifacts.js";
import {
  checkReadPaths,
  formatReadPaths,
  type ReadPathOutcome
} from "./verify-read-path.js";
import {
  discoverConfiguredFiles,
  selectVerifiableFiles
} from "./verify-discover.js";
import {
  readFileAtRef,
  resolveGitBaseRef,
  resolveGitFiles
} from "./verify-git.js";

// Re-exported so `../src/commands/verify.js` stays the public entry point for
// the verify command's surface (tests and callers import from here).
export {
  checkReadPaths,
  formatReadPaths,
  discoverConfiguredFiles,
  selectVerifiableFiles
};
export type { ReadPathOutcome };

export interface VerifyOptions {
  strict: boolean;
  json: boolean;
  changed: boolean;
  all: boolean;
  planOnly?: boolean;
  withSlice?: boolean;
  before?: string;
  after?: string;
  format?: "text" | "json" | "github";
  diff?: string;
}

export interface FileOutcome {
  file: string;
  kind:
    | StatementKind
    | "query_pair"
    | "table_assumption"
    | "repo_diff"
    | "error";
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
  const options: VerifyOptions = {
    strict: false,
    json: false,
    changed: false,
    all: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--format") {
      const format = argv[i + 1];
      if (!format || format.startsWith("--")) {
        return {
          files,
          options,
          error: "--format requires text, json, or github."
        };
      }
      if (format !== "text" && format !== "json" && format !== "github") {
        return {
          files,
          options,
          error: "--format must be text, json, or github."
        };
      }
      options.format = format;
      if (format === "json") options.json = true;
      i += 1;
    } else if (arg === "--changed") options.changed = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--plan-only") options.planOnly = true;
    else if (arg === "--with-slice") {
      return {
        files,
        options,
        error:
          "--with-slice is not available yet. Local slice escalation is built but not wired into the planner."
      };
    } else if (arg === "--before") {
      const file = argv[i + 1];
      if (!file || file.startsWith("--")) {
        return { files, options, error: "--before requires a SQL file." };
      }
      options.before = file;
      i += 1;
    } else if (arg === "--after") {
      const file = argv[i + 1];
      if (!file || file.startsWith("--")) {
        return { files, options, error: "--after requires a SQL file." };
      }
      options.after = file;
      i += 1;
    } else if (arg === "--diff") {
      const range = argv[i + 1];
      if (!range || range.startsWith("--")) {
        return {
          files,
          options,
          error: "--diff requires a git range, e.g. origin/main...HEAD"
        };
      }
      options.diff = range;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { files, options, error: `Unknown flag: ${arg}` };
    } else {
      files.push(arg);
    }
  }

  if (Boolean(options.before) !== Boolean(options.after)) {
    return {
      files,
      options,
      error: "--before and --after must be supplied together."
    };
  }
  if ((options.before || options.after) && files.length > 0) {
    return {
      files,
      options,
      error: "--before/--after cannot be combined with positional files."
    };
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

async function verifyChangedFiles(
  client: ClickHouseMetadataClient,
  files: string[],
  defaultDatabase: string,
  options: VerifyOptions,
  env: NodeJS.ProcessEnv,
  config?: GozzleProjectConfig
): Promise<FileOutcome[]> {
  const baseRef = resolveGitBaseRef(options);
  if (!baseRef) {
    return verifyFiles(client, files, defaultDatabase, options, env, config);
  }

  const outcomes: FileOutcome[] = [];
  for (const file of files) {
    const current = await readFile(file, "utf8");
    const previous = await readFileAtRef(baseRef, file);
    if (previous === undefined) {
      outcomes.push(
        await verifyFile(client, file, defaultDatabase, options, env, config)
      );
      continue;
    }

    const currentArtifact = classifyArtifact({
      source: "content",
      content: current,
      path: file
    });
    const previousArtifact = classifyArtifact({
      source: "content",
      content: previous,
      path: file
    });
    if (currentArtifact.type !== "query" || previousArtifact.type !== "query") {
      outcomes.push(
        await verifyFile(client, file, defaultDatabase, options, env, config)
      );
      continue;
    }

    const run = await verifyArtifact(
      client,
      {
        source: "query_pair",
        left: previous,
        right: current,
        path: `${baseRef}:${file}...${file}`
      },
      {
        defaultDatabase,
        source: "cli",
        strict: options.strict,
        planOnly: options.planOnly,
        allowLocalSlice: options.withSlice,
        path: file,
        env,
        projectConfig: config,
        gitBase: true
      }
    );
    outcomes.push(fileOutcomeFromRun(file, run, options));
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
    const outcome = operationalError(
      file,
      `could not read file: ${errorMessage(error)}`
    );
    await audit(env, file, "error", start);
    return outcome;
  }

  try {
    const run = await verifyArtifact(
      client,
      { source: "content", content: raw, path: file },
      {
        defaultDatabase,
        source: "cli",
        strict: options.strict,
        planOnly: options.planOnly,
        allowLocalSlice: options.withSlice,
        path: file,
        env,
        projectConfig: config
      }
    );
    const outcome = fileOutcomeFromRun(file, run, options);
    await audit(env, file, outcome.errored ? "error" : "ok", start);
    return outcome;
  } catch (error) {
    const outcome = operationalError(file, errorMessage(error));
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

function fileOutcomeFromRun(
  file: string,
  run: VerificationRun,
  options: VerifyOptions
): FileOutcome {
  return {
    file,
    kind: run.artifact.type === "unknown" ? "error" : run.artifact.type,
    label: labelForRun(run),
    failing: isFailingRun(run, options),
    errored: run.artifact.type === "unknown",
    text: formatVerificationRun(run),
    json: run as unknown as Record<string, unknown>
  };
}

function isFailingRun(run: VerificationRun, options: VerifyOptions): boolean {
  if (run.verdict === "fail") return true;
  if (run.artifact.type === "migration" && run.verdict === "warn") return true;
  return Boolean(options.strict && run.verdict === "warn");
}

function labelForRun(run: VerificationRun): string {
  if (run.artifact.type === "query") return "SELECT";
  if (run.artifact.type === "query_pair") return "QUERY PAIR";
  if (run.artifact.type === "migration") return "ALTER";
  return "error";
}

function formatVerificationRun(run: VerificationRun): string {
  const lines = [
    `Verdict: ${run.verdict.toUpperCase()}`,
    `Confidence: ${run.confidence}`,
    `Checks: ${run.plan.executedChecks.join(", ") || "none"}`
  ];
  if (run.coverage.note) {
    lines.push(`Coverage: ${run.coverage.note}`);
  }
  if (run.findings.length > 0) {
    const readPathFindings = run.findings.filter((finding) =>
      finding.id.startsWith("read_path_")
    );
    if (readPathFindings.length > 0) {
      lines.push("", "Read-path proof:");
      for (const finding of readPathFindings) {
        lines.push(`- [${finding.severity}] ${finding.message}`);
      }
    }
    lines.push("", "Findings:");
    for (const finding of run.findings) {
      lines.push(`- [${finding.severity}] ${finding.id}: ${finding.message}`);
    }
  }
  if (run.limits.length > 0) {
    lines.push("", "Limits:");
    for (const limit of run.limits) {
      lines.push(`- [${limit.type}] ${limit.message}`);
    }
  }
  if (run.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const recommendation of run.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }
  return lines.join("\n");
}

export function aggregateExitCode(outcomes: FileOutcome[]): number {
  if (outcomes.some((o) => o.errored)) return 2;
  if (outcomes.some((o) => o.failing)) return 1;
  return 0;
}

export function renderHuman(outcomes: FileOutcome[]): string {
  const blocks = outcomes.map((o) => `▸ ${o.file}  (${o.label})\n${o.text}`);
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

export function renderGithub(outcomes: FileOutcome[]): string {
  const failing = outcomes.filter(
    (outcome) => outcome.failing || outcome.errored
  );
  const verdict = failing.length > 0 ? "FAIL" : "PASS";
  const lines = [
    "## gozzle verification",
    "",
    `**Verdict:** ${verdict}`,
    "",
    "| File | Verdict | Findings |",
    "| --- | --- | --- |"
  ];

  for (const outcome of outcomes) {
    const run = outcome.json as unknown as VerificationRun;
    const findingIds =
      run.findings?.length > 0
        ? run.findings.map((finding) => `\`${finding.id}\``).join(", ")
        : outcome.errored
          ? "`error`"
          : "-";
    lines.push(
      `| \`${outcome.file}\` | ${run.verdict?.toUpperCase?.() ?? "ERROR"} | ${findingIds} |`
    );
  }

  const detailed = outcomes
    .map((outcome) => outcome.json as unknown as VerificationRun)
    .filter((run) => run.findings?.length > 0 || run.limits?.length > 0);
  if (detailed.length > 0) {
    lines.push("", "### Findings and limits");
    for (const run of detailed) {
      lines.push("", `#### ${run.artifact.path ?? run.artifact.fingerprint}`);
      for (const finding of run.findings ?? []) {
        lines.push(
          `- **${finding.severity.toUpperCase()}** \`${finding.id}\`: ${finding.message}`
        );
      }
      for (const limit of run.limits ?? []) {
        lines.push(`- **LIMIT** \`${limit.type}\`: ${limit.message}`);
      }
    }
  }

  return lines.join("\n");
}

function renderOutcomes(
  outcomes: FileOutcome[],
  options: VerifyOptions
): string {
  if (options.format === "github") return renderGithub(outcomes);
  if (options.json || options.format === "json") return renderJson(outcomes);
  return renderHuman(outcomes);
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

  let loaded;
  try {
    loaded = await readProjectConfig();
  } catch (configError) {
    console.error(errorMessage(configError));
    return 2;
  }
  const project = loaded?.config;

  if (options.before && options.after) {
    try {
      const [left, right] = await Promise.all([
        readFile(options.before, "utf8"),
        readFile(options.after, "utf8")
      ]);
      return await withClickHouseClient(async (client, config) => {
        const path = `${options.before}...${options.after}`;
        const run = await verifyArtifact(
          client,
          { source: "query_pair", left, right, path },
          {
            defaultDatabase: config.database ?? project?.database ?? "default",
            source: "cli",
            strict: options.strict,
            planOnly: options.planOnly,
            allowLocalSlice: options.withSlice,
            path,
            env,
            projectConfig: project
          }
        );
        const outcome = fileOutcomeFromRun(path, run, options);
        console.log(renderOutcomes([outcome], options));
        return aggregateExitCode([outcome]);
      }, env);
    } catch (pairError) {
      console.error(
        `gozzle verify could not compare query files.\n\n${errorMessage(pairError)}`
      );
      return 2;
    }
  }

  let targetFiles = argFiles;
  if (options.all) {
    if (
      !loaded ||
      loaded.config.queries.length + loaded.config.migrations.length === 0
    ) {
      console.error(
        "gozzle verify --all needs a gozzle.yaml with queries and/or migrations globs."
      );
      return 2;
    }
    targetFiles = await discoverConfiguredFiles(
      dirname(loaded.path),
      loaded.config
    );
    if (targetFiles.length === 0) {
      console.log("No ClickHouse files matched the configured globs.");
      return 0;
    }
  } else if (options.changed || options.diff) {
    try {
      targetFiles = await resolveGitFiles(options, project);
    } catch (gitError) {
      console.error(
        `gozzle verify could not resolve changed files.\n\n${errorMessage(gitError)}`
      );
      return 2;
    }
    if (targetFiles.length === 0) {
      console.log("No changed ClickHouse files to verify.");
      return 0;
    }
  } else if (argFiles.length === 0) {
    console.error(
      "Usage: gozzle verify <file ...> | --changed | --diff <range> | --all [--strict] [--json]"
    );
    return 2;
  }

  try {
    return await withClickHouseClient(async (client, config) => {
      const defaultDatabase = config.database ?? project?.database ?? "default";
      const outcomes =
        options.changed || options.diff
          ? await verifyChangedFiles(
              client,
              targetFiles,
              defaultDatabase,
              options,
              env,
              project
            )
          : await verifyFiles(
              client,
              targetFiles,
              defaultDatabase,
              options,
              env,
              project
            );
      console.log(renderOutcomes(outcomes, options));
      return aggregateExitCode(outcomes);
    }, env);
  } catch (runError) {
    console.error(`gozzle verify could not run.\n\n${errorMessage(runError)}`);
    return 2;
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
