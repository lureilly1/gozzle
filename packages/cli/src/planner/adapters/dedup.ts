import { randomUUID } from "node:crypto";

import type { VerifyDedupResult } from "../../clickhouse/dedup.js";
import { fingerprint } from "../../shared/fingerprint.js";
import type { Finding, Limit, VerificationRun } from "../../shared/verdict.js";

export function dedupToRun(
  result: VerifyDedupResult,
  source: VerificationRun["artifact"]["source"],
  path?: string
): VerificationRun {
  const findings = dedupFindings(result);
  const limits = dedupLimits(result);
  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarning = findings.some((finding) => finding.severity === "warn");
  const verdict =
    result.scanSkipped || !result.eligible
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
      type: "table_assumption",
      source,
      path,
      fingerprint: fingerprint(
        `${result.identifier.database}.${result.identifier.table}:${result.sortingKey ?? ""}`
      )
    },
    verdict,
    severity:
      verdict === "fail"
        ? "error"
        : verdict === "warn" || verdict === "indeterminate"
          ? "warn"
          : "none",
    confidence: verdict === "indeterminate" ? "advisory" : "exact",
    confidenceByCategory: {
      correctness: verdict === "indeterminate" ? "advisory" : "exact"
    },
    coverage: {
      scope: result.isPartitioned ? "partition" : "table",
      rowsChecked: result.scanSkipped ? undefined : result.totalRows,
      note: result.scanSkipped
        ? "Scan guard skipped the proof; scope to one partition or raise the guard."
        : "Exact duplicate check over the selected ClickHouse scope."
    },
    plan: {
      selectedStrategies: result.scanSkipped
        ? ["metadata_only"]
        : ["production_exact"],
      skippedStrategies: result.scanSkipped
        ? [
            {
              strategy: "production_exact",
              reason:
                result.reason ?? "The table exceeded the dedup scan guard."
            }
          ]
        : [],
      executedChecks: ["dedup_safety"]
    },
    findings,
    limits,
    recommendations: dedupRecommendations(result),
    productionExecuted: false
  };
}

function dedupFindings(result: VerifyDedupResult): Finding[] {
  const findings: Finding[] = [];

  if (result.eligible && !result.scanSkipped && result.duplicateRows > 0) {
    findings.push({
      id: "dedup_duplicates_present",
      title: "ReplacingMergeTree duplicates are present",
      severity: "error",
      verdict: "fail",
      category: "correctness",
      evidenceLevel: "exact",
      strategy: "production_exact",
      message: `${result.duplicateRows} duplicate row(s) across ${result.duplicateGroups} sorting-key group(s) would be collapsed by a merge or FINAL.`,
      evidence: [
        { label: "duplicateGroups", value: result.duplicateGroups },
        { label: "duplicateRows", value: result.duplicateRows },
        { label: "finalCollapsibleRows", value: result.finalCollapsibleRows },
        { label: "maxCopies", value: result.maxCopies }
      ],
      limits: [],
      recommendation:
        "Use FINAL where correctness requires it, fix ingestion deduplication, or scope the assumption by partition.",
      blocking: true
    });
  }

  for (const warning of result.warnings) {
    findings.push({
      id: "dedup_scope_warning",
      title: "Deduplication scope differs",
      severity: "warn",
      verdict: "warn",
      category: "correctness",
      evidenceLevel: "exact",
      strategy: "production_exact",
      message: warning,
      evidence: [
        { label: "duplicateRows", value: result.duplicateRows },
        { label: "finalCollapsibleRows", value: result.finalCollapsibleRows }
      ],
      limits: [],
      recommendation:
        "Account for cross-partition duplicates when relying on SELECT FINAL.",
      blocking: false
    });
  }

  return findings;
}

function dedupLimits(result: VerifyDedupResult): Limit[] {
  if (result.scanSkipped) {
    return [
      {
        type: "budget",
        message:
          result.reason ??
          "The table exceeded the verify_dedup scan guard, so no full proof was run."
      }
    ];
  }
  if (!result.eligible) {
    return [
      {
        type: "advisory_only",
        message:
          result.reason ??
          "This table is not eligible for ReplacingMergeTree dedup verification."
      }
    ];
  }
  return [];
}

function dedupRecommendations(result: VerifyDedupResult): string[] {
  if (result.scanSkipped) {
    return ["Re-run verify_dedup with a partitionId or create a local slice."];
  }
  if (!result.eligible) {
    return [
      result.reason ?? "Review the table engine before relying on dedup."
    ];
  }
  if (result.duplicateRows > 0) {
    return [
      "Use FINAL where correctness requires it, fix ingestion deduplication, or scope the assumption by partition."
    ];
  }
  return [];
}
