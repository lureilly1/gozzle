import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { verifyDedup, type VerifyDedupResult } from "../clickhouse/dedup.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { runAuditedTool } from "../shared/audit.js";

export function createVerifyDedupTool(server: McpServer): void {
  server.registerTool(
    "verify_dedup",
    {
      title: "Verify ClickHouse Deduplication",
      description:
        "Prove whether a ReplacingMergeTree table currently holds duplicate rows by sorting key (per partition). ClickHouse deduplicates lazily during merges, so a plain SELECT count() can be misleading; this returns a verdict plus evidence.",
      inputSchema: {
        table: z
          .string()
          .min(1)
          .describe("Table name in table or database.table format."),
        sampleLimit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many duplicated keys to return as evidence (default 5).")
      }
    },
    async ({ table, sampleLimit }) =>
      runAuditedTool("verify_dedup", { table, sampleLimit }, async () => {
        let client: ClickHouseHttpMetadataClient | undefined;

        try {
          const config = readClickHouseConfig();
          client = new ClickHouseHttpMetadataClient(config);
          const result = await verifyDedup(client, {
            table,
            defaultDatabase: config.database ?? "default",
            sampleLimit
          });

          return {
            content: [{ type: "text", text: formatDedupResult(result) }]
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Gozzle could not verify deduplication.\n\n${formatErrorMessage(
                  error
                )}`
              }
            ]
          };
        } finally {
          await client?.close();
        }
      })
  );
}

export function formatDedupResult(result: VerifyDedupResult): string {
  const tableName = `${result.identifier.database}.${result.identifier.table}`;

  if (!result.eligible) {
    return [
      `Table: ${tableName}`,
      `Engine: ${result.engine}`,
      "",
      `Verdict: not eligible for verify_dedup.`,
      result.reason ?? ""
    ]
      .join("\n")
      .trimEnd();
  }

  const verdict =
    result.duplicateRows > 0
      ? `${result.duplicateRows} duplicate row(s) across ${result.duplicateGroups} sorting-key group(s) would be collapsed by a merge or FINAL.`
      : "No pre-merge duplicates by sorting key. The table is effectively deduplicated right now.";

  const lines = [
    `Table: ${tableName}`,
    `Engine: ${result.engine}`,
    `Dedup key (ORDER BY): ${result.sortingKey}`,
    `Partitioned: ${result.isPartitioned ? "yes" : "no"}`,
    `Total rows: ${result.totalRows}`,
    "",
    `Verdict: ${verdict}`
  ];

  if (result.duplicateRows > 0) {
    lines.push(
      `Most-duplicated key has ${result.maxCopies} copies.`,
      "",
      "Sample duplicated keys:"
    );
    for (const row of result.sample) {
      const keyDescription = Object.entries(row.key)
        .map(([column, value]) => `${column}=${formatValue(value)}`)
        .join(", ");
      lines.push(
        `- [partition ${row.partitionId}] ${keyDescription} -> ${row.copies} copies`
      );
    }
  }

  if (result.warnings.length > 0) {
    lines.push("", "Notes:");
    lines.push(...result.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
