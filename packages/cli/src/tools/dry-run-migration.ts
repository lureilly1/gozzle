import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import {
  dryRunMigration,
  type DryRunMigrationResult
} from "../clickhouse/migration.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { formatBytes, formatCount } from "../shared/format.js";
import { runAuditedTool } from "../shared/audit.js";

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
          .describe("One ClickHouse ALTER TABLE statement to assess.")
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
        statementSha256: z.string()
      }
    },
    async ({ statement }) =>
      runAuditedTool(
        "dry_run_migration",
        { statementSha256: fingerprint(statement) },
        async () => {
          let client: ClickHouseHttpMetadataClient | undefined;
          try {
            const config = readClickHouseConfig();
            client = new ClickHouseHttpMetadataClient(config);
            const result = await dryRunMigration(client, {
              statement,
              defaultDatabase: config.database ?? "default"
            });
            return {
              content: [{ type: "text", text: formatMigrationResult(result) }],
              structuredContent: buildMigrationStructured(result)
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `gozzle could not dry-run the migration.\n\n${formatErrorMessage(
                    error
                  )}`
                }
              ]
            };
          } finally {
            await client?.close();
          }
        }
      )
  );
}

export function formatMigrationResult(result: DryRunMigrationResult): string {
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

  lines.push("", `Advice: ${parsed.advice}`, "", "Statement:", parsed.statement);
  return lines.join("\n");
}

function migrationVerdict(result: DryRunMigrationResult): string {
  const { parsed, rewrite } = result;
  if (parsed.classification === "unsupported") {
    return "unsupported; no cost or safety claim was inferred.";
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

export function buildMigrationStructured(result: DryRunMigrationResult) {
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
    statementSha256: fingerprint(result.parsed.statement)
  };
}

function migrationStatus(classification: string): string {
  if (classification === "metadata-only") {
    return "PASS — metadata-only, no part rewrite";
  }
  if (classification === "unsupported") {
    return "UNKNOWN — could not classify; review manually";
  }
  return "REVIEW — may rewrite existing data parts";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprint(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}
