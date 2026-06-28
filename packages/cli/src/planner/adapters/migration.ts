import { randomUUID } from "node:crypto";

import type { DryRunMigrationResult } from "../../clickhouse/migration.js";
import { fingerprint } from "../../shared/fingerprint.js";
import type { Finding, Limit, VerificationRun } from "../../shared/verdict.js";

export function migrationToRun(
  result: DryRunMigrationResult,
  source: VerificationRun["artifact"]["source"],
  path?: string
): VerificationRun {
  const limits: Limit[] = [];
  const findings = [...correctnessFindings(result), ...rewriteFindings(result)];

  if (result.parsed.classification === "unsupported") {
    limits.push({
      type: "unsupported_syntax",
      message: result.parsed.reason
    });
  }

  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarning = findings.some((finding) => finding.severity === "warn");
  const verdict =
    result.parsed.classification === "unsupported"
      ? "indeterminate"
      : hasError
        ? "fail"
        : hasWarning
          ? "warn"
          : "pass";

  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    artifact: {
      type: "migration",
      source,
      path,
      fingerprint: fingerprint(result.parsed.statement)
    },
    verdict,
    severity:
      verdict === "fail"
        ? "error"
        : verdict === "warn" || verdict === "indeterminate"
          ? "warn"
          : "none",
    confidence:
      verdict === "indeterminate"
        ? "advisory"
        : result.correctness.length > 0
          ? "bounded"
          : "metadata",
    confidenceByCategory: {
      migration:
        verdict === "indeterminate"
          ? "advisory"
          : result.correctness.length > 0
            ? "bounded"
            : "metadata"
    },
    coverage: {
      scope: result.parsed.predicate ? "predicate" : "metadata",
      rowsMatched: result.rewrite.matchingRows,
      bytesChecked: result.rewrite.affectedBytes,
      note:
        result.correctness.length > 0
          ? "Read-only correctness checks were run against current ClickHouse data."
          : "No expression, cast, or predicate correctness check was inferred."
    },
    plan: {
      selectedStrategies: ["metadata_only", "production_bounded_probe"],
      skippedStrategies: [
        {
          strategy: "local_slice_simulation",
          reason: "Migration shadow execution is not implemented in this phase."
        }
      ],
      executedChecks: ["migration_blast_radius", "migration_correctness"]
    },
    findings,
    limits,
    recommendations: [result.parsed.advice],
    productionExecuted: false
  };
}

function correctnessFindings(result: DryRunMigrationResult): Finding[] {
  return result.correctness.map((finding) => ({
    id: `migration_${finding.check}`,
    title: finding.check,
    severity:
      finding.status === "error"
        ? "error"
        : finding.status === "warning" || finding.status === "unknown"
          ? "warn"
          : "info",
    verdict: finding.status === "error" ? "fail" : "pass",
    category: "migration",
    evidenceLevel: finding.status === "unknown" ? "advisory" : "bounded",
    strategy: "production_bounded_probe",
    message: finding.message,
    evidence: [{ label: "check", value: finding.check }],
    limits:
      finding.status === "unknown"
        ? [
            {
              type: "advisory_only",
              message: "This correctness check could not be proven."
            }
          ]
        : [],
    blocking: finding.status === "error"
  }));
}

function rewriteFindings(result: DryRunMigrationResult): Finding[] {
  if (
    result.parsed.classification === "unsupported" ||
    result.rewrite.evidence === "none" ||
    result.rewrite.affectedParts === 0
  ) {
    return [];
  }

  return [
    {
      id: "migration_rewrite_footprint",
      title: "Migration may rewrite data parts",
      severity: "warn",
      verdict: "warn",
      category: "migration",
      evidenceLevel: "metadata",
      strategy: "metadata_only",
      message: `${result.rewrite.affectedParts} active part(s), ${result.rewrite.affectedPartRows} row(s), and ${result.rewrite.affectedBytes} compressed byte(s) may be rewritten.`,
      evidence: [
        { label: "affectedParts", value: result.rewrite.affectedParts },
        { label: "affectedPartRows", value: result.rewrite.affectedPartRows },
        { label: "affectedBytes", value: result.rewrite.affectedBytes },
        { label: "rewriteEvidence", value: result.rewrite.evidence }
      ],
      limits: [
        {
          type: "advisory_only",
          message:
            "gozzle did not execute the ALTER and does not prove lock duration, replication lag, or merge impact."
        }
      ],
      recommendation:
        "Review the rewrite footprint before scheduling the ALTER.",
      blocking: false
    }
  ];
}
