export type Verdict = "pass" | "fail" | "warn" | "indeterminate";

// Existing query-equivalence semantics. Keep this explicit while the planner
// introduces the broader pass/fail/warn/indeterminate run contract.
export type EquivalenceVerdict =
  | "correct"
  | "incorrect"
  | "likely-correct"
  | "indeterminate";

export type VerifyMethod = "exact-source" | "exact-replica" | "sampled";

export type EvidenceLevel =
  | "exact"
  | "bounded"
  | "metadata"
  | "explain"
  | "sampled"
  | "advisory";

export type VerificationStrategy =
  | "static_parse"
  | "metadata_only"
  | "production_explain"
  | "production_bounded_probe"
  | "production_exact"
  | "local_slice_exact"
  | "local_slice_simulation"
  | "advisory";

export type FindingCategory =
  | "correctness"
  | "cost"
  | "performance"
  | "semantic"
  | "migration"
  | "governance"
  | "coverage";

export interface Limit {
  type:
    | "scope"
    | "budget"
    | "timeout"
    | "permissions"
    | "unsupported_syntax"
    | "advisory_only"
    | "sampled"
    | "stale_metadata";
  message: string;
}

export interface Evidence {
  label: string;
  value: string | number | boolean | null;
}

export interface Finding {
  id: string;
  title: string;
  severity: "info" | "warn" | "error";
  verdict: Verdict;
  category: FindingCategory;
  evidenceLevel: EvidenceLevel;
  strategy: VerificationStrategy;
  message: string;
  evidence: Evidence[];
  limits: Limit[];
  recommendation?: string;
  blocking: boolean;
}

export interface CoverageSummary {
  scope: "table" | "partition" | "predicate" | "metadata" | "query" | "unknown";
  rowsChecked?: number;
  rowsMatched?: number;
  bytesChecked?: number;
  note?: string;
}

export interface ArtifactSummary {
  type:
    | "query"
    | "query_pair"
    | "migration"
    | "repo_diff"
    | "table_assumption"
    | "unknown";
  source: "cli" | "mcp" | "ci" | "hook";
  path?: string;
  fingerprint: string;
}

export interface VerificationPlanSummary {
  selectedStrategies: VerificationStrategy[];
  skippedStrategies: Array<{ strategy: VerificationStrategy; reason: string }>;
  executedChecks: string[];
}

export interface VerificationRun {
  runId: string;
  createdAt: string;
  artifact: ArtifactSummary;
  verdict: Verdict;
  severity: "none" | "info" | "warn" | "error";
  confidence: EvidenceLevel;
  confidenceByCategory: Partial<Record<FindingCategory, EvidenceLevel>>;
  coverage: CoverageSummary;
  plan: VerificationPlanSummary;
  findings: Finding[];
  limits: Limit[];
  recommendations: string[];
  productionExecuted: false;
}

export interface Coverage {
  scope: "table" | "partition" | "sample";
  rowsCompared?: number;
  note?: string;
}

export function aggregateVerdict(
  findings: Finding[],
  limits: Limit[] = []
): Verdict {
  if (
    findings.some((finding) => finding.blocking && finding.severity === "error")
  ) {
    return "fail";
  }
  if (
    limits.some(
      (limit) => limit.type === "budget" || limit.type === "permissions"
    )
  ) {
    return "indeterminate";
  }
  if (
    findings.some(
      (finding) => finding.severity === "warn" || finding.verdict === "warn"
    )
  ) {
    return "warn";
  }
  return "pass";
}

/** Map a check verdict to a process exit code for CLI/CI gating. */
export function verdictExitCode(
  verdict: EquivalenceVerdict | Verdict
): 0 | 1 | 2 {
  if (
    verdict === "correct" ||
    verdict === "likely-correct" ||
    verdict === "pass"
  ) {
    return 0;
  }
  if (verdict === "incorrect" || verdict === "fail" || verdict === "warn") {
    return 1;
  }
  return 2;
}
