import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { verifyArtifact } from "../planner/planner.js";
import { runAuditedTool } from "../shared/audit.js";
import { errorMessage } from "../shared/errors.js";
import { fingerprint } from "../shared/fingerprint.js";
import type { VerificationRun } from "../shared/verdict.js";
import { withClickHouseTool } from "./with-clickhouse.js";

export function createVerifyArtifactTool(server: McpServer): void {
  server.registerTool(
    "verify_artifact",
    {
      title: "Verify ClickHouse Artifact",
      description:
        "Classify a ClickHouse query or migration, choose the strongest safe verification plan, and return a verdict with evidence and limits.",
      inputSchema: {
        content: z
          .string()
          .min(1)
          .describe("One ClickHouse SELECT/WITH query or ALTER migration."),
        artifactType: z
          .enum(["auto", "query", "migration"])
          .default("auto")
          .describe("Optional caller hint; auto lets gozzle classify."),
        path: z.string().optional().describe("Optional source path."),
        allowLocalSlice: z
          .boolean()
          .default(false)
          .describe("Allow future planner slice escalation when implemented.")
      },
      outputSchema: {
        runId: z.string(),
        createdAt: z.string(),
        artifact: z.any(),
        verdict: z.enum(["pass", "fail", "warn", "indeterminate"]),
        severity: z.enum(["none", "info", "warn", "error"]),
        confidence: z.enum([
          "exact",
          "bounded",
          "metadata",
          "explain",
          "sampled",
          "advisory"
        ]),
        confidenceByCategory: z.any(),
        coverage: z.any(),
        plan: z.any(),
        findings: z.array(z.any()),
        limits: z.array(z.any()),
        recommendations: z.array(z.string()),
        productionExecuted: z.literal(false)
      }
    },
    async ({ content, artifactType, path, allowLocalSlice }) =>
      runAuditedTool(
        "verify_artifact",
        {
          path,
          artifactType,
          artifactSha256: fingerprint(content)
        },
        () =>
          withClickHouseTool(
            async (client, config) => {
              const run = await verifyArtifact(
                client,
                { source: "content", content, path },
                {
                  defaultDatabase: config.database ?? "default",
                  source: "mcp",
                  allowLocalSlice
                }
              );
              return {
                content: [{ type: "text", text: formatVerificationRun(run) }],
                structuredContent: run as unknown as Record<string, unknown>
              };
            },
            (error) =>
              `gozzle could not verify the artifact.\n\n${errorMessage(error)}`
          )
      )
  );
}

export function formatVerificationRun(run: VerificationRun): string {
  const lines = [
    `Verdict: ${run.verdict.toUpperCase()}`,
    `Artifact: ${run.artifact.type}`,
    `Confidence: ${run.confidence}`,
    `Checks: ${run.plan.executedChecks.join(", ") || "none"}`
  ];
  if (run.coverage.note) lines.push(`Coverage: ${run.coverage.note}`);
  if (run.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of run.findings) {
      lines.push(`- [${finding.severity}] ${finding.id}: ${finding.message}`);
    }
  }
  if (run.limits.length > 0) {
    lines.push("", "Limits:");
    for (const limit of run.limits) {
      lines.push(`- [${limit.type}] ${limit.message}`);
    }
  }
  if (run.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const recommendation of run.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }
  return lines.join("\n");
}
