import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import {
  diagnoseQuery,
  type DiagnoseQueryResult,
  type QueryFinding
} from "../clickhouse/query-diagnosis.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { runAuditedTool } from "../shared/audit.js";

export function createDiagnoseQueryTool(server: McpServer): void {
  server.registerTool(
    "diagnose_query",
    {
      title: "Diagnose ClickHouse Query",
      description:
        "Run EXPLAIN indexes=1, projections=1 for one SELECT and return proven pruning findings separately from advisory query-shape risks. The original query is never executed.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("One ClickHouse SELECT or WITH ... SELECT query to diagnose.")
      },
      outputSchema: {
        status: z.enum(["pass", "warn", "fail"]),
        originalQueryExecuted: z.literal(false),
        tables: z.array(
          z.object({
            table: z.string(),
            orderBy: z.string().optional(),
            partitionBy: z.string().optional()
          })
        ),
        findings: z.array(
          z.object({
            confidence: z.enum(["proven", "advisory"]),
            severity: z.enum(["high", "medium", "low"]),
            code: z.string(),
            message: z.string(),
            evidence: z.string().optional(),
            recommendation: z.string()
          })
        ),
        queryFingerprint: z.string()
      }
    },
    async ({ query }) =>
      runAuditedTool(
        "diagnose_query",
        { querySha256: fingerprint(query) },
        async () => {
          let client: ClickHouseHttpMetadataClient | undefined;
          try {
            const config = readClickHouseConfig();
            client = new ClickHouseHttpMetadataClient(config);
            const result = await diagnoseQuery(client, query, config.database ?? "default");
            return {
              content: [{ type: "text", text: formatQueryDiagnosis(result) }],
              structuredContent: buildDiagnosisStructured(result)
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `gozzle could not diagnose the query.\n\nQuery fingerprint: ${fingerprint(
                    query
                  )}\n${formatDiagnosticError(error)}`
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

export function formatQueryDiagnosis(result: DiagnoseQueryResult): string {
  const proven = result.findings.filter(
    (finding) => finding.confidence === "proven"
  );
  const advisory = result.findings.filter(
    (finding) => finding.confidence === "advisory"
  );
  const lines = [
    `Status: ${queryStatus(proven, advisory)}`,
    `Verdict: ${formatVerdict(proven, advisory)}`,
    "Original query execution: not run (EXPLAIN only)"
  ];

  if (result.explain.tables.length > 0) {
    lines.push("", "EXPLAIN evidence:");
    for (const table of result.explain.tables) {
      lines.push(`- ${table.table}`);
      const schema = result.tableSchemas.find((s) => s.table === table.table);
      if (schema?.orderBy) lines.push(`  ORDER BY: ${schema.orderBy}`);
      if (schema?.partitionBy) lines.push(`  PARTITION BY: ${schema.partitionBy}`);
      for (const index of table.indexes) {
        const details = [
          index.condition ? `condition=${index.condition}` : undefined,
          index.parts
            ? `parts=${index.parts.selected}/${index.parts.total}`
            : undefined,
          index.granules
            ? `granules=${index.granules.selected}/${index.granules.total}`
            : undefined
        ].filter(Boolean);
        lines.push(`  ${index.type}: ${details.join(", ") || "reported"}`);
      }
    }
  }

  appendFindings(lines, "Proven findings", proven);
  appendFindings(lines, "Advisories", advisory);
  lines.push("", `Query fingerprint: ${fingerprint(result.query.query)}`);
  return lines.join("\n");
}

export function buildDiagnosisStructured(result: DiagnoseQueryResult) {
  const proven = result.findings.filter((f) => f.confidence === "proven");
  const advisory = result.findings.filter((f) => f.confidence === "advisory");
  return {
    status: proven.length > 0 ? "fail" : advisory.length > 0 ? "warn" : "pass",
    originalQueryExecuted: false as const,
    tables: result.tableSchemas,
    findings: result.findings,
    queryFingerprint: fingerprint(result.query.query)
  };
}

function queryStatus(proven: QueryFinding[], advisory: QueryFinding[]): string {
  if (proven.length > 0) {
    return `FAIL — ${proven.length} proven pruning issue(s)`;
  }
  if (advisory.length > 0) {
    return `WARN — ${advisory.length} advisory finding(s), none proven`;
  }
  return "PASS — no pruning problem found";
}

function formatVerdict(
  proven: QueryFinding[],
  advisory: QueryFinding[]
): string {
  if (proven.length === 0 && advisory.length === 0) {
    return "no pruning problem or static advisory was found in this EXPLAIN plan.";
  }
  if (proven.length === 0) {
    return `no proven pruning problem; ${advisory.length} advisory finding(s).`;
  }
  return `${proven.length} proven pruning concern(s); ${advisory.length} advisory finding(s).`;
}

function appendFindings(
  lines: string[],
  heading: string,
  findings: QueryFinding[]
): void {
  if (findings.length === 0) return;
  lines.push("", `${heading}:`);
  for (const finding of findings) {
    lines.push(`- [${finding.severity}] ${finding.message}`);
    if (finding.evidence) lines.push(`  Evidence: ${finding.evidence}`);
    lines.push(`  Recommendation: ${finding.recommendation}`);
  }
}

function fingerprint(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function formatDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safePrefixes = [
    "diagnose_query ",
    "Query is required.",
    "SQL comments are not accepted",
    "Top-level ",
    "External table function ",
    "WITH query must ",
    "Missing ClickHouse URL.",
    "ClickHouse URL must "
  ];
  if (safePrefixes.some((prefix) => message.startsWith(prefix))) {
    return message;
  }
  const code = message.match(/\bCode:\s*\d+\b/)?.[0];
  return `${code ? `${code}. ` : ""}ClickHouse rejected EXPLAIN. Review the query syntax and referenced schema.`;
}
