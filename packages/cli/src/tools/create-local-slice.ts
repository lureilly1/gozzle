import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { readLocalSliceConfig } from "../config/local-slice.js";
import { ChdbLocalEngine } from "../local-engine/chdb.js";
import {
  createLocalSlice,
  type LocalSliceResult
} from "../local-engine/slice.js";
import { runAuditedTool } from "../shared/audit.js";

export function createLocalSliceTool(server: McpServer): void {
  server.registerTool(
    "create_local_slice",
    {
      title: "Create Faithful Local ClickHouse Slice",
      description:
        "Copy one complete ReplacingMergeTree partition to a bounded local chDB workspace, replay its DDL, rerun deduplication proof, and write a manifest. The workspace contains production data and persists until explicitly cleaned. Refuses partial partitions because ClickHouse deduplication is partition-scoped.",
      inputSchema: {
        table: z
          .string()
          .min(1)
          .describe("Table name in table or database.table format."),
        partitionId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Physical partition_id to reproduce. Required when the table has multiple active partitions."
          )
      }
    },
    async ({ table, partitionId }) =>
      runAuditedTool("create_local_slice", { table, partitionId }, async () => {
        let client: ClickHouseHttpMetadataClient | undefined;
        try {
          const clickhouse = readClickHouseConfig();
          client = new ClickHouseHttpMetadataClient(clickhouse);
          const result = await createLocalSlice(
            client,
            new ChdbLocalEngine(),
            {
              table,
              partitionId,
              defaultDatabase: clickhouse.database ?? "default"
            },
            readLocalSliceConfig()
          );
          return {
            content: [{ type: "text", text: formatLocalSliceResult(result) }]
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Gozzle could not create a local slice.\n\n${formatErrorMessage(
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

export function formatLocalSliceResult(result: LocalSliceResult): string {
  const { manifest } = result;
  const verdict = manifest.proof.matched
    ? "verified: local duplicate proof matches the source partition"
    : "not verified: local and source duplicate proof differ";
  const lines = [
    `Table: ${manifest.source.table}`,
    `Partition: ${manifest.source.partitionId}`,
    `Rows copied: ${manifest.source.rows}`,
    `Source bytes on disk: ${manifest.source.bytesOnDisk}`,
    `Parquet bytes: ${manifest.local.dataBytes}`,
    `Workspace bytes: ${result.workspaceSizeBytes}`,
    `Total local slice storage: ${result.totalStorageBytes}`,
    `Local engine: ${manifest.engine}`,
    "",
    `Verdict: ${verdict}.`,
    `Source duplicate rows: ${manifest.proof.sourceDuplicateRows}`,
    `Local duplicate rows: ${manifest.proof.localDuplicateRows}`,
    "",
    `Workspace: ${result.workspacePath}`,
    `Manifest: ${result.manifestPath}`,
    `Cleanup: ${result.cleanupCommand}`
  ];
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
