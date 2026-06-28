import { randomUUID } from "node:crypto";

import type {
  DiagnoseQueryResult,
  QueryFinding
} from "../../clickhouse/query-diagnosis.js";
import { fingerprint } from "../../shared/fingerprint.js";
import type { Finding, VerificationRun } from "../../shared/verdict.js";

export function diagnosisToRun(
  result: DiagnoseQueryResult,
  source: VerificationRun["artifact"]["source"],
  path?: string
): VerificationRun {
  const findings = result.findings.map(diagnosisFindingToFinding);
  const hasBlocking = findings.some((finding) => finding.blocking);
  const hasWarning = findings.some((finding) => finding.severity === "warn");
  const verdict = hasBlocking ? "fail" : hasWarning ? "warn" : "pass";

  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    artifact: {
      type: "query",
      source,
      path,
      fingerprint: fingerprint(result.query.query)
    },
    verdict,
    severity: hasBlocking ? "error" : hasWarning ? "warn" : "none",
    confidence: hasBlocking || hasWarning ? "explain" : "metadata",
    confidenceByCategory: {
      performance: hasBlocking || hasWarning ? "explain" : "metadata"
    },
    coverage: {
      scope: "query",
      note: "Original query was not executed; diagnosis used EXPLAIN and static query-shape checks."
    },
    plan: {
      selectedStrategies: ["production_explain", "static_parse"],
      skippedStrategies: [],
      executedChecks: ["query_diagnosis"]
    },
    findings,
    limits: [],
    recommendations: [...new Set(result.findings.map((f) => f.recommendation))],
    productionExecuted: false
  };
}

function diagnosisFindingToFinding(finding: QueryFinding): Finding {
  const proven = finding.confidence === "proven";
  const high = finding.severity === "high";
  return {
    id: `query_${finding.code}`,
    title: titleFromCode(finding.code),
    severity: proven && high ? "error" : "warn",
    verdict: proven && high ? "fail" : "warn",
    category: proven ? "performance" : "cost",
    evidenceLevel: proven ? "explain" : "advisory",
    strategy: proven ? "production_explain" : "static_parse",
    message: finding.message,
    evidence: [
      { label: "confidence", value: finding.confidence },
      { label: "severity", value: finding.severity },
      ...(finding.evidence
        ? [{ label: "evidence", value: finding.evidence }]
        : [])
    ],
    limits: proven
      ? []
      : [
          {
            type: "advisory_only",
            message:
              "This finding is based on static query shape, not executed runtime behavior."
          }
        ],
    recommendation: finding.recommendation,
    blocking: proven && high
  };
}

function titleFromCode(code: string): string {
  return code
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
