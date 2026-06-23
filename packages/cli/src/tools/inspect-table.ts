import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage } from "../shared/errors.js";
import { z } from "zod";

import {
  inspectTable,
  type TableInspection
} from "../clickhouse/table-inspection.js";
import { runAuditedTool } from "../shared/audit.js";
import { withClickHouseTool } from "./with-clickhouse.js";

export function createInspectTableTool(server: McpServer): void {
  server.registerTool(
    "inspect_table",
    {
      title: "Inspect ClickHouse Table",
      description:
        "Inspect a ClickHouse table's physical layout and eligible gozzle checks.",
      inputSchema: {
        table: z
          .string()
          .min(1)
          .describe("Table name in table or database.table format.")
      }
    },
    async ({ table }) =>
      runAuditedTool("inspect_table", { table }, () =>
        withClickHouseTool(
          async (client, config) => {
            const inspection = await inspectTable(client, {
              table,
              defaultDatabase: config.database ?? "default"
            });
            return {
              content: [
                { type: "text", text: formatTableInspection(inspection) }
              ]
            };
          },
          (error) =>
            `gozzle could not inspect the table.\n\n${errorMessage(error)}`
        )
      )
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
