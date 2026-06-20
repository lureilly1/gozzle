import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import {
  dryRunMigration,
  type DryRunMigrationResult
} from "../clickhouse/migration.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
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
              content: [{ type: "text", text: formatMigrationResult(result) }]
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Gozzle could not dry-run the migration.\n\n${formatErrorMessage(
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
    `Table: ${result.identifier.database}.${result.identifier.table}`,
    `Engine: ${result.engine}`,
    `Classification: ${parsed.classification}`,
    "Production execution: not run (read-only analysis)",
    "",
    `Verdict: ${migrationVerdict(result)}`,
    parsed.reason,
    "",
    "Current table footprint:",
    `- rows: ${footprint.rows}`,
    `- active parts: ${footprint.activeParts}`,
    `- compressed bytes: ${footprint.bytesOnDisk}`
  ];

  if (parsed.classification !== "unsupported") {
    lines.push(
      "",
      "Estimated physical rewrite:",
      `- matching rows: ${rewrite.matchingRows}`,
      `- rows in touched parts: ${rewrite.affectedPartRows}`,
      `- touched parts: ${rewrite.affectedParts}`,
      `- compressed bytes in touched parts: ${rewrite.affectedBytes}`,
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
  return `${rewrite.affectedParts} active part(s), containing ${rewrite.affectedPartRows} row(s) and ${formatBytes(
    rewrite.affectedBytes
  )}, may be rewritten.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprint(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}
