
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorMessage } from "../shared/errors.js";
import { fingerprint } from "../shared/fingerprint.js";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import {
  verifyEquivalent,
  type VerifyEquivalentResult
} from "../clickhouse/equivalent.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { runAuditedTool } from "../shared/audit.js";

export function createVerifyEquivalentTool(server: McpServer): void {
  server.registerTool(
    "verify_equivalent",
    {
      title: "Verify Two ClickHouse Queries Are Equivalent",
      description:
        "Prove whether two SELECTs return the same result (same multiset of rows) against real data, computed entirely in ClickHouse. Use after rewriting/refactoring a query. Neither query is mutated.",
      inputSchema: {
        left: z.string().min(1).describe("The original SELECT query."),
        right: z.string().min(1).describe("The rewritten SELECT to compare."),
        sampleLimit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many differing rows to return as evidence (default 10).")
      },
      outputSchema: {
        verdict: z.enum(["correct", "incorrect", "indeterminate"]),
        method: z.literal("exact-source"),
        differingRows: z.number(),
        leftOnly: z.number(),
        rightOnly: z.number(),
        renamed: z.boolean(),
        indeterminateReason: z.string().optional()
      }
    },
    async ({ left, right, sampleLimit }) =>
      runAuditedTool(
        "verify_equivalent",
        { leftSha256: fingerprint(left), rightSha256: fingerprint(right) },
        async () => {
          let client: ClickHouseHttpMetadataClient | undefined;
          try {
            const config = readClickHouseConfig();
            client = new ClickHouseHttpMetadataClient(config);
            const result = await verifyEquivalent(client, {
              left,
              right,
              sampleLimit
            });
            return {
              content: [{ type: "text", text: formatEquivalentResult(result) }],
              structuredContent: buildEquivalentStructured(result)
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `gozzle could not verify equivalence.\n\n${errorMessage(
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

export function buildEquivalentStructured(result: VerifyEquivalentResult) {
  return {
    verdict: result.verdict,
    method: result.method,
    differingRows: result.differingRows,
    leftOnly: result.leftOnly,
    rightOnly: result.rightOnly,
    renamed: result.renamed ?? false,
    ...(result.indeterminateReason
      ? { indeterminateReason: result.indeterminateReason }
      : {})
  };
}

export function formatEquivalentResult(result: VerifyEquivalentResult): string {
  const status = result.verdict.toUpperCase();
  const lines = [
    `Status: ${status}`,
    `Method: exact-source (compared in ClickHouse, no data copied)`
  ];

  if (result.verdict === "indeterminate") {
    lines.push("", result.indeterminateReason ?? "Equivalence could not be proven.");
    return lines.join("\n");
  }

  if (result.shapeMismatch) {
    lines.push(
      "",
      "Verdict: not equivalent — result shapes differ.",
      `  left:  ${formatShape(result.shapeMismatch.left)}`,
      `  right: ${formatShape(result.shapeMismatch.right)}`
    );
    return lines.join("\n");
  }

  if (result.verdict === "correct") {
    lines.push("", "Verdict: equivalent — both queries return the same rows.");
    return lines.join("\n");
  }

  // incorrect
  if (result.renamed && result.differingRows === 0) {
    lines.push(
      "",
      "Verdict: not equivalent — rows are identical but column names differ."
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    `Verdict: not equivalent — ${result.differingRows} differing row(s) (left-only ${result.leftOnly}, right-only ${result.rightOnly}).`
  );
  if (result.renamed) {
    lines.push("Column names also differ between the two results.");
  }
  if (result.sample.length > 0) {
    lines.push("", "Sample of differing rows:");
    for (const row of result.sample) {
      const side = String(row._side ?? "?");
      const cells = Object.entries(row)
        .filter(([key]) => key !== "_side")
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(", ");
      lines.push(`- [${side}] ${cells}`);
    }
  }
  return lines.join("\n");
}

function formatShape(shape: { name: string; type: string }[]): string {
  return shape.map((column) => `${column.name}:${column.type}`).join(", ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return typeof value === "string" ? value : JSON.stringify(value);
}


