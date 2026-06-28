import assert from "node:assert/strict";
import test from "node:test";

import {
  createVerifyArtifactTool,
  formatVerificationRun
} from "../src/tools/verify-artifact.js";
import type { VerificationRun } from "../src/shared/verdict.js";

interface RegisteredTool {
  name: string;
  config: Record<string, unknown>;
}

class FakeMcpServer {
  readonly tools: RegisteredTool[] = [];

  registerTool(
    name: string,
    config: Record<string, unknown>,
    _handler: unknown
  ): void {
    this.tools.push({ name, config });
  }
}

function run(over: Partial<VerificationRun> = {}): VerificationRun {
  return {
    runId: "run-1",
    createdAt: "2026-06-28T00:00:00.000Z",
    artifact: { type: "query", source: "mcp", fingerprint: "abc" },
    verdict: "pass",
    severity: "none",
    confidence: "exact",
    confidenceByCategory: {},
    coverage: { scope: "query" },
    plan: {
      selectedStrategies: ["production_exact"],
      skippedStrategies: [],
      executedChecks: ["query_equivalence"]
    },
    findings: [],
    limits: [],
    recommendations: [],
    productionExecuted: false,
    ...over
  };
}

test("createVerifyArtifactTool registers verify_artifact with verdict schema", () => {
  const server = new FakeMcpServer();
  createVerifyArtifactTool(server as never);

  assert.equal(server.tools.length, 1);
  const tool = server.tools[0];
  assert.equal(tool.name, "verify_artifact");

  const inputSchema = tool.config.inputSchema as Record<string, unknown>;
  assert.ok("content" in inputSchema);
  assert.ok("artifactType" in inputSchema);
  assert.ok("allowLocalSlice" in inputSchema);

  const outputSchema = tool.config.outputSchema as Record<string, unknown>;
  assert.ok("verdict" in outputSchema);
  assert.ok("confidence" in outputSchema);
  assert.ok("findings" in outputSchema);
  assert.ok("limits" in outputSchema);
});

test("formatVerificationRun summarizes a passing run", () => {
  const text = formatVerificationRun(run());
  assert.match(text, /Verdict: PASS/);
  assert.match(text, /Artifact: query/);
  assert.match(text, /Confidence: exact/);
  assert.match(text, /Checks: query_equivalence/);
});

test("formatVerificationRun lists findings, limits, and recommendations", () => {
  const text = formatVerificationRun(
    run({
      verdict: "fail",
      severity: "error",
      findings: [
        {
          id: "query_not_equivalent",
          title: "Query result changed",
          severity: "error",
          verdict: "fail",
          category: "correctness",
          evidenceLevel: "exact",
          strategy: "production_exact",
          message: "Exact comparison found 3 differing row(s).",
          evidence: [],
          limits: [],
          blocking: true
        }
      ],
      limits: [{ type: "budget", message: "Scan budget exceeded." }],
      recommendations: ["Compare a narrower scope."]
    })
  );
  assert.match(text, /Verdict: FAIL/);
  assert.match(text, /- \[error\] query_not_equivalent: Exact comparison/);
  assert.match(text, /- \[budget\] Scan budget exceeded\./);
  assert.match(text, /- Compare a narrower scope\./);
});
