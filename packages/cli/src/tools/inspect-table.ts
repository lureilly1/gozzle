import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { inspectTable, type TableInspection } from "../clickhouse/table-inspection.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { runAuditedTool } from "../shared/audit.js";

export function createInspectTableTool(server: McpServer): void {
  server.registerTool(
    "inspect_table",
    {
      title: "Inspect ClickHouse Table",
      description:
        "Inspect a ClickHouse table's physical layout and eligible Gozzle checks.",
      inputSchema: {
        table: z
          .string()
          .min(1)
          .describe("Table name in table or database.table format.")
      }
    },
    async ({ table }) =>
      runAuditedTool("inspect_table", { table }, async () => {
        let client: ClickHouseHttpMetadataClient | undefined;

        try {
          const config = readClickHouseConfig();
          client = new ClickHouseHttpMetadataClient(config);
          const inspection = await inspectTable(client, {
            table,
            defaultDatabase: config.database ?? "default"
          });

          return {
            content: [
              {
                type: "text",
                text: formatTableInspection(inspection)
              }
            ]
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Gozzle could not inspect the table.\n\n${formatErrorMessage(
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

export function formatTableInspection(inspection: TableInspection): string {
  const lines = [
    `Table: ${inspection.identifier.database}.${inspection.identifier.table}`,
    `Engine: ${inspection.engineFull}`,
    `Order by: ${inspection.orderBy ?? inspection.sortingKey ?? "none"}`,
    `Partition by: ${inspection.partitionBy ?? "none"}`,
    `Primary key: ${inspection.primaryKey ?? "none"}`,
    `Active parts: ${inspection.parts.activeParts}`,
    `Rows: ${inspection.totalRows}`,
    `Bytes on disk: ${inspection.totalBytes}`,
    "",
    "Eligible checks:",
    `- verify_dedup: ${inspection.eligibleChecks.verifyDedup ? "yes" : "no"}`,
    `- create_local_slice: ${
      inspection.eligibleChecks.createLocalSlice ? "yes" : "no"
    }`,
    `- dry_run_migration: ${
      inspection.eligibleChecks.dryRunMigration ? "yes" : "no"
    }`,
    `- diagnose_query: ${inspection.eligibleChecks.diagnoseQuery ? "yes" : "no"}`
  ];

  if (inspection.replacingMergeTree) {
    lines.push(
      "",
      "ReplacingMergeTree:",
      `- version column: ${inspection.replacingMergeTree.versionColumn ?? "none"}`,
      `- deleted column: ${inspection.replacingMergeTree.deletedColumn ?? "none"}`
    );
  }

  if (inspection.warnings.length > 0) {
    lines.push("", "Warnings:");
    lines.push(...inspection.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
