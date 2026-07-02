import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage } from "../shared/errors.js";
import { fingerprint } from "../shared/fingerprint.js";
import { z } from "zod";

import {
  correctnessVerdict,
  dryRunMigration,
  type DryRunMigrationResult
} from "../clickhouse/migration.js";
import {
  readEphemeralSliceConfig,
  readLocalSliceConfig
} from "../config/local-slice.js";
import { ChdbLocalEngine } from "../local-engine/chdb.js";
import {
  shadowExecuteMigration,
  ShadowMigrationUnsupportedError,
  type ShadowMigrationResult
} from "../local-engine/shadow-migration.js";
import { migrationToRun } from "../planner/adapters/migration.js";
import { formatBytes, formatCount } from "../shared/format.js";
import { runAuditedTool } from "../shared/audit.js";
import { withClickHouseTool } from "./with-clickhouse.js";

export function createDryRunMigrationTool(server: McpServer): void {
  server.registerTool(
    "dry_run_migration",
    {
      title: "Dry Run ClickHouse Migration",
      description:
        "Classify one ALTER TABLE statement and estimate rewritten rows, parts, and bytes without executing it on production.",
      inputSchema: {
        statement: z
          .string()
          .min(1)
          .describe("One ClickHouse ALTER TABLE statement to assess."),
        partitionId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Physical partition_id to shadow-execute the mutation against. When provided, gozzle replays that complete partition into an ephemeral local chDB slice, actually runs the ALTER there, and reports the real before/after effect. Never touches production. Supported for predicate UPDATE and DELETE mutations."
          )
      },
      outputSchema: {
        status: z.enum(["pass", "review", "unknown"]),
        classification: z.string(),
        table: z.string(),
        productionExecuted: z.literal(false),
        footprint: z.object({
          rows: z.number(),
          activeParts: z.number(),
          bytesOnDisk: z.number()
        }),
        rewrite: z.object({
          matchingRows: z.number(),
          affectedPartRows: z.number(),
          affectedParts: z.number(),
          affectedBytes: z.number(),
          evidence: z.string()
        }),
        correctnessStatus: z.enum(["ok", "warning", "error", "unknown"]),
        correctness: z.array(
          z.object({
            check: z.string(),
            status: z.enum(["ok", "warning", "error", "unknown"]),
            message: z.string()
          })
        ),
        statementSha256: z.string(),
        verificationRun: z.any(),
        shadow: z.any().optional(),
        shadowSkippedReason: z.string().optional()
      }
    },
    async ({ statement, partitionId }) =>
      runAuditedTool(
        "dry_run_migration",
        { statementSha256: fingerprint(statement), partitionId },
        () =>
          withClickHouseTool(
            async (client, config) => {
              const defaultDatabase = config.database ?? "default";
              const result = await dryRunMigration(client, {
                statement,
                defaultDatabase
              });
              const shadow = await runShadowExecution(
                client,
                statement,
                partitionId,
                defaultDatabase
              );
              return {
                content: [
                  {
                    type: "text",
                    text: formatMigrationResult(result, shadow)
                  }
                ],
                structuredContent: buildMigrationStructured(
                  result,
                  "mcp",
                  undefined,
                  shadow
                )
              };
            },
            (error) =>
              `gozzle could not dry-run the migration.\n\n${errorMessage(error)}`
          )
      )
  );
}

/**
 * The outcome of the optional chDB shadow-execution escalation: either a real
 * result, or a human-readable reason it did not run. Shadow execution is
 * best-effort — it never fails the dry run, because the read-only estimate is
 * always the primary verdict.
 */
export type ShadowOutcome =
  | { kind: "result"; result: ShadowMigrationResult }
  | { kind: "skipped"; reason: string };

async function runShadowExecution(
  client: Parameters<Parameters<typeof withClickHouseTool>[0]>[0],
  statement: string,
  partitionId: string | undefined,
  defaultDatabase: string
): Promise<ShadowOutcome> {
  if (!partitionId) {
    return {
      kind: "skipped",
      reason:
        "No partitionId was provided. Pass one to shadow-execute this mutation in an ephemeral local chDB slice."
    };
  }
  try {
    const result = await shadowExecuteMigration(
      client,
      new ChdbLocalEngine(),
      { statement, partitionId, defaultDatabase },
      readLocalSliceConfig(),
      readEphemeralSliceConfig()
    );
    return { kind: "result", result };
  } catch (error) {
    if (error instanceof ShadowMigrationUnsupportedError) {
      return { kind: "skipped", reason: error.message };
    }
    return {
      kind: "skipped",
      reason: `Shadow execution could not run: ${errorMessage(error)}`
    };
  }
}

export function formatMigrationResult(
  result: DryRunMigrationResult,
  shadow?: ShadowOutcome
): string {
  const { parsed, footprint, rewrite } = result;
  const lines = [
    `Status: ${migrationStatus(parsed.classification)}`,
    `Table: ${result.identifier.database}.${result.identifier.table}`,
    `Engine: ${result.engine}`,
    `Classification: ${parsed.classification}`,
    "Production execution: not run (read-only analysis)",
    "",
    `Verdict: ${migrationVerdict(result)}`,
    parsed.reason,
    "",
    "Current table footprint:",
    `- rows: ${formatCount(footprint.rows)}`,
    `- active parts: ${formatCount(footprint.activeParts)}`,
    `- compressed size: ${formatBytes(footprint.bytesOnDisk)}`
  ];

  if (parsed.classification !== "unsupported") {
    lines.push(
      "",
      "Estimated physical rewrite:",
      `- matching rows: ${formatCount(rewrite.matchingRows)}`,
      `- rows in touched parts: ${formatCount(rewrite.affectedPartRows)}`,
      `- touched parts: ${formatCount(rewrite.affectedParts)}`,
      `- compressed size of touched parts: ${formatBytes(rewrite.affectedBytes)}`,
      `- evidence: ${rewrite.evidence}`
    );
  }

  if (result.correctness.length > 0) {
    lines.push(
      "",
      "Read-only correctness gate:",
      `- verdict: ${correctnessVerdict(result.correctness)} (proven against current data; production ALTER not run)`
    );
    for (const finding of result.correctness) {
      lines.push(`- ${finding.status}: ${finding.check}: ${finding.message}`);
    }
  } else {
    lines.push(
      "",
      "Read-only correctness gate:",
      "- verdict: not applicable; no expression, cast, or predicate check was inferred."
    );
  }

  if (shadow) {
    lines.push("", ...formatShadowSection(shadow));
  }

  lines.push(
    "",
    `Advice: ${parsed.advice}`,
    "",
    "Statement:",
    parsed.statement
  );
  return lines.join("\n");
}

function formatShadowSection(shadow: ShadowOutcome): string[] {
  if (shadow.kind === "skipped") {
    return ["Shadow execution (chDB):", `- not run: ${shadow.reason}`];
  }
  const { result } = shadow;
  const lines = [
    "Shadow execution (chDB): the exact ALTER was run against an ephemeral local slice; production was not touched.",
    `- partition: ${result.partitionId} (${formatCount(result.sliceRows)} rows replayed)`,
    `- rows matching predicate: ${formatCount(result.matchedRows)}`
  ];
  if (!result.executed) {
    lines.push(
      `- verdict: REJECTED; ClickHouse refused the statement against faithful data: ${result.executionError}`
    );
    return lines;
  }
  if (result.operation === "DELETE") {
    lines.push(
      `- rows deleted: ${formatCount(result.rowsDeleted)} (${formatCount(
        result.before.rows
      )} -> ${formatCount(result.after.rows)} physical rows)`,
      "- verdict: OK; the DELETE executed against faithful data."
    );
  } else {
    lines.push(
      `- rows rewritten: ${formatCount(result.matchedRows)}`,
      "- verdict: OK; the UPDATE executed against faithful data."
    );
  }
  return lines;
}

function migrationVerdict(result: DryRunMigrationResult): string {
  const { parsed, rewrite } = result;
  const correctness = correctnessVerdict(result.correctness);
  if (parsed.classification === "unsupported") {
    return "unsupported; no cost or safety claim was inferred.";
  }
  if (correctness === "error") {
    return "read-only correctness gate found errors against current data.";
  }
  if (correctness === "unknown") {
    return "read-only correctness gate could not prove every check.";
  }
  if (parsed.classification === "metadata-only") {
    return "no existing data-part rewrite expected.";
  }
  if (parsed.rewriteScope === "none") {
    return "no immediate part rewrite, but materialized-column behavior is risky.";
  }
  if (rewrite.affectedParts === 0) {
    return "no currently active parts match the proposed mutation.";
  }
  return `${formatCount(rewrite.affectedParts)} active part(s), containing ${formatCount(
    rewrite.affectedPartRows
  )} row(s) and ${formatBytes(rewrite.affectedBytes)}, may be rewritten.`;
}

export function buildMigrationStructured(
  result: DryRunMigrationResult,
  source: "cli" | "mcp" | "ci" | "hook" = "cli",
  path?: string,
  shadow?: ShadowOutcome
) {
  const classification = result.parsed.classification;
  return {
    status:
      classification === "metadata-only"
        ? ("pass" as const)
        : classification === "unsupported"
          ? ("unknown" as const)
          : ("review" as const),
    classification,
    table: `${result.identifier.database}.${result.identifier.table}`,
    productionExecuted: false as const,
    footprint: result.footprint,
    rewrite: result.rewrite,
    correctnessStatus: correctnessVerdict(result.correctness),
    correctness: result.correctness,
    statementSha256: fingerprint(result.parsed.statement),
    verificationRun: migrationToRun(result, source, path),
    ...(shadow?.kind === "result" ? { shadow: shadow.result } : {}),
    ...(shadow?.kind === "skipped"
      ? { shadowSkippedReason: shadow.reason }
      : {})
  };
}

function migrationStatus(classification: string): string {
  if (classification === "metadata-only") {
    return "PASS: metadata-only, no part rewrite";
  }
  if (classification === "unsupported") {
    return "UNKNOWN: could not classify; review manually";
  }
  return "REVIEW: may rewrite existing data parts";
}
