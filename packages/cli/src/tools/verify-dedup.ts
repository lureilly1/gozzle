import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage } from "../shared/errors.js";
import { readNonNegativeInt } from "../config/env.js";
import { z } from "zod";

import { verifyDedup, type VerifyDedupResult } from "../clickhouse/dedup.js";
import { runAuditedTool } from "../shared/audit.js";
import { withClickHouseTool } from "./with-clickhouse.js";

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
          .describe("How many duplicated keys to return as evidence (default 5)."),
        partitionId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Scope the proof to one physical partition id (from inspect_table). Use this for large tables."
          )
      },
      outputSchema: {
        eligible: z.boolean(),
        scanSkipped: z.boolean(),
        table: z.string(),
        engine: z.string(),
        isPartitioned: z.boolean(),
        totalRows: z.number(),
        duplicateGroups: z.number(),
        duplicateRows: z.number(),
        finalCollapsibleRows: z.number(),
        maxCopies: z.number(),
        reason: z.string().optional()
      }
    },
    async ({ table, sampleLimit, partitionId }) =>
      runAuditedTool(
        "verify_dedup",
        { table, sampleLimit, partitionId },
        () =>
          withClickHouseTool(async (client, config) => {
            const scanGuard = readDedupScanGuard();
            const result = await verifyDedup(client, {
              table,
              defaultDatabase: config.database ?? "default",
              sampleLimit,
              partitionId,
              maxScanRows: scanGuard.maxScanRows,
              maxScanBytes: scanGuard.maxScanBytes
            });
            return {
              content: [{ type: "text", text: formatDedupResult(result) }],
              structuredContent: buildDedupStructured(result)
            };
          }, formatDedupError)
      )
  );
}

export function buildDedupStructured(result: VerifyDedupResult) {
  return {
    eligible: result.eligible,
    scanSkipped: result.scanSkipped ?? false,
    table: `${result.identifier.database}.${result.identifier.table}`,
    engine: result.engine,
    isPartitioned: result.isPartitioned,
    totalRows: result.totalRows,
    duplicateGroups: result.duplicateGroups,
    duplicateRows: result.duplicateRows,
    finalCollapsibleRows: result.finalCollapsibleRows,
    maxCopies: result.maxCopies,
    ...(result.reason ? { reason: result.reason } : {})
  };
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

  if (result.scanSkipped) {
    const lines = [
      `Table: ${tableName}`,
      `Engine: ${result.engine}`,
      `Dedup key (ORDER BY): ${result.sortingKey}`,
      `Total rows: ${result.totalRows}`,
      "",
      "Verdict: table too large to prove in one pass.",
      result.reason ?? ""
    ];
    if (result.largestPartitions && result.largestPartitions.length > 0) {
      lines.push("", "Largest partitions (re-run with partitionId):");
      for (const partition of result.largestPartitions) {
        lines.push(
          `- ${partition.partitionId} (${partition.rows} rows, ${partition.bytes} bytes)`
        );
      }
    }
    return lines.join("\n").trimEnd();
  }

  const lines = [
    `Table: ${tableName}`,
    `Engine: ${result.engine}`,
    `Dedup key (ORDER BY): ${result.sortingKey}`,
    `Partitioned: ${result.isPartitioned ? "yes" : "no"}`,
    `Total rows: ${result.totalRows}`,
    ""
  ];

  if (result.duplicateRows === 0 && result.finalCollapsibleRows === 0) {
    lines.push(
      "Verdict: No duplicates by sorting key. The table is effectively deduplicated right now."
    );
  } else if (result.duplicateRows === result.finalCollapsibleRows) {
    // Single partition, or duplicates are entirely within partitions: background
    // merges and SELECT FINAL collapse the same rows.
    lines.push(
      `Verdict: ${result.duplicateRows} duplicate row(s) across ${result.duplicateGroups} sorting-key group(s) would be collapsed by a merge or FINAL.`
    );
  } else {
    // Multi-partition: merges (per partition) and FINAL (global) differ.
    lines.push(
      "Verdict: duplicates differ by scope on this partitioned table:",
      `- Background merges collapse ${result.duplicateRows} row(s) across ${result.duplicateGroups} per-partition group(s) (the eventual physical floor).`,
      `- SELECT ... FINAL collapses ${result.finalCollapsibleRows} row(s) (it deduplicates globally by sorting key).`
    );
  }

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

const DEFAULT_MAX_SCAN_ROWS = 200_000_000;
const DEFAULT_MAX_SCAN_BYTES = 50_000_000_000;

interface DedupScanGuard {
  maxScanRows: number;
  maxScanBytes: number;
}

/**
 * Read the full-table scan guard for verify_dedup. Set either to 0 to force a
 * full-table proof regardless of size.
 */
export function readDedupScanGuard(
  env: NodeJS.ProcessEnv = process.env
): DedupScanGuard {
  return {
    maxScanRows: readNonNegativeInt(
      env.GOZZLE_DEDUP_MAX_SCAN_ROWS,
      DEFAULT_MAX_SCAN_ROWS
    ),
    maxScanBytes: readNonNegativeInt(
      env.GOZZLE_DEDUP_MAX_SCAN_BYTES,
      DEFAULT_MAX_SCAN_BYTES
    )
  };
}


function formatDedupError(error: unknown): string {
  const message = errorMessage(error);
  const base = `gozzle could not verify deduplication.\n\n${message}`;
  // A read-limit or timeout abort means the table is too big for a single-pass
  // proof; steer the caller to the cheaper, scoped path.
  if (/max_execution_time|TIMEOUT_EXCEEDED|Limit for|too many|memory limit/i.test(message)) {
    return `${base}\n\nThis table is likely too large to prove in one pass. Re-run verify_dedup with a partitionId to scope to one partition, or create a local slice.`;
  }
  return base;
}

