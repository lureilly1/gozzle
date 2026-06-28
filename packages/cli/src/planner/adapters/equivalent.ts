import { randomUUID } from "node:crypto";

import type { VerifyEquivalentResult } from "../../clickhouse/equivalent.js";
import { fingerprint } from "../../shared/fingerprint.js";
import type { Finding, Limit, VerificationRun } from "../../shared/verdict.js";

export function equivalentToRun(
  result: VerifyEquivalentResult,
  artifact: {
    left: string;
    right: string;
    source: VerificationRun["artifact"]["source"];
    path?: string;
  }
): VerificationRun {
  const limits: Limit[] = [];
  const findings: Finding[] = [];

  if (result.verdict === "indeterminate") {
    limits.push({
      type: "budget",
      message:
        result.indeterminateReason ??
        "Query equivalence could not be proven exactly."
    });
  } else if (result.verdict === "incorrect") {
    findings.push({
      id: result.shapeMismatch
        ? "query_shape_mismatch"
        : result.renamed && result.differingRows === 0
          ? "query_column_names_changed"
          : "query_not_equivalent",
      title: result.shapeMismatch
        ? "Query result shape changed"
        : result.renamed && result.differingRows === 0
          ? "Query column names changed"
          : "Query result changed",
      severity: "error",
      verdict: "fail",
      category: "correctness",
      evidenceLevel: "exact",
      strategy: "production_exact",
      message: result.shapeMismatch
        ? "The two queries return different column shapes."
        : result.renamed && result.differingRows === 0
          ? "Rows are identical, but output column names differ."
          : `Exact comparison found ${result.differingRows} differing row(s).`,
      evidence: [
        { label: "leftOnly", value: result.leftOnly },
        { label: "rightOnly", value: result.rightOnly },
        { label: "differingRows", value: result.differingRows }
      ],
      limits: [],
      recommendation: result.shapeMismatch
        ? "Align the selected columns and types before comparing row values."
        : "Review the differing-row sample and fix the rewrite before shipping.",
      blocking: true
    });
  }

  const verdict =
    result.verdict === "indeterminate"
      ? "indeterminate"
      : findings.length > 0
        ? "fail"
        : "pass";

  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    artifact: {
      type: "query_pair",
      source: artifact.source,
      path: artifact.path,
      fingerprint: fingerprint(`${artifact.left}\n---\n${artifact.right}`)
    },
    verdict,
    severity:
      verdict === "fail"
        ? "error"
        : verdict === "indeterminate"
          ? "warn"
          : "none",
    confidence: verdict === "indeterminate" ? "advisory" : "exact",
    confidenceByCategory: {
      correctness: verdict === "indeterminate" ? "advisory" : "exact"
    },
    coverage: {
      scope: "query",
      note:
        verdict === "indeterminate"
          ? result.indeterminateReason
          : "Exact multiset comparison in ClickHouse."
    },
    plan: {
      selectedStrategies: ["production_exact"],
      skippedStrategies: [],
      executedChecks: ["query_equivalence"]
    },
    findings,
    limits,
    recommendations:
      verdict === "indeterminate"
        ? ["Add matching filters to both queries or compare a narrower scope."]
        : [],
    productionExecuted: false
  };
}
