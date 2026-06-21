import type { ClickHouseMetadataClient } from "./client.js";
import {
  parseExplainRows,
  type ExplainEvidence,
  type ExplainRow,
  type IndexEvidence,
  type TableExplainEvidence
} from "./explain.js";
import {
  validateDiagnosticQuery,
  type ValidatedQuery
} from "./query-validator.js";

export interface QueryFinding {
  confidence: "proven" | "advisory";
  severity: "high" | "medium" | "low";
  code: string;
  message: string;
  evidence?: string;
  recommendation: string;
}

export interface DiagnoseQueryResult {
  query: ValidatedQuery;
  explain: ExplainEvidence;
  findings: QueryFinding[];
  originalQueryExecuted: false;
}

export async function diagnoseQuery(
  client: ClickHouseMetadataClient,
  query: string
): Promise<DiagnoseQueryResult> {
  const validated = validateDiagnosticQuery(query);
  const rows = await client.queryJson<ExplainRow>(`
    EXPLAIN indexes = 1, projections = 1
    ${validated.query}
  `);
  const explain = parseExplainRows(rows);
  const findings = [
    ...explain.tables.flatMap(diagnoseTable),
    ...buildAdvisories(validated, explain)
  ];

  return {
    query: validated,
    explain,
    findings,
    originalQueryExecuted: false
  };
}

function diagnoseTable(table: TableExplainEvidence): QueryFinding[] {
  const findings: QueryFinding[] = [];
  const minMax = findIndex(table, "MinMax");
  const partition = findIndex(table, "Partition");
  const primary = findIndex(table, "PrimaryKey");
  const baseParts = minMax?.parts ?? partition?.parts ?? primary?.parts;
  const finalGranules = primary?.granules ?? partition?.granules ?? minMax?.granules;

  if (
    baseParts &&
    finalGranules &&
    selectsEverything(baseParts) &&
    selectsEverything(finalGranules)
  ) {
    findings.push({
      confidence: "proven",
      severity: "high",
      code: "full-scan",
      message: `${table.table} scans every reported part and granule.`,
      evidence: `parts ${formatRatio(baseParts)}, granules ${formatRatio(finalGranules)}`,
      recommendation:
        "Align filters with the partition or leading ORDER BY keys, or evaluate a projection for this access pattern."
    });
  }

  if (
    partition?.condition === "true" &&
    partition.parts &&
    partition.parts.total > 1 &&
    selectsEverything(partition.parts)
  ) {
    findings.push({
      confidence: "proven",
      severity: "medium",
      code: "missing-partition-pruning",
      message: `${table.table} received no partition pruning.`,
      evidence: `Partition Condition: true; parts ${formatRatio(partition.parts)}`,
      recommendation:
        "Filter on the partition expression with a compatible range when the query should target fewer partitions."
    });
  }

  if (
    primary?.condition === "true" &&
    primary.granules &&
    primary.granules.total > 1 &&
    selectsEverything(primary.granules)
  ) {
    findings.push({
      confidence: "proven",
      severity: "medium",
      code: "missing-primary-key-pruning",
      message: `${table.table} received no primary-key granule pruning.`,
      evidence: `PrimaryKey Condition: true; granules ${formatRatio(primary.granules)}`,
      recommendation:
        "Filter on a useful prefix of the ORDER BY key without wrapping key columns in incompatible functions."
    });
  }

  return findings;
}

function buildAdvisories(
  query: ValidatedQuery,
  explain: ExplainEvidence
): QueryFinding[] {
  const findings: QueryFinding[] = [];
  if (query.hasFinal) {
    findings.push({
      confidence: "advisory",
      severity: "medium",
      code: "final-cost",
      message: "FINAL performs merge-time reconciliation during the read.",
      recommendation:
        "Run verify_dedup on the source table before deciding whether FINAL is required for correctness."
    });
  }
  if (query.hasFunctionWrappedPredicate) {
    findings.push({
      confidence: "advisory",
      severity: "medium",
      code: "function-wrapped-predicate",
      message: "A WHERE or PREWHERE predicate applies a function to a value.",
      recommendation:
        "Compare against the stored key representation where possible; function-wrapped key columns can prevent index pruning."
    });
  }
  if (query.hasLeadingWildcard) {
    findings.push({
      confidence: "advisory",
      severity: "medium",
      code: "leading-wildcard",
      message: "A leading-wildcard LIKE predicate usually cannot use ordered-key ranges.",
      recommendation: "Consider a text index or a different predicate shape for substring search."
    });
  }
  if (query.hasCrossJoin || query.joinCount > 1) {
    findings.push({
      confidence: "advisory",
      severity: query.hasCrossJoin ? "high" : "medium",
      code: "join-shape",
      message: query.hasCrossJoin
        ? "The query contains a CROSS JOIN."
        : `The query contains ${query.joinCount} JOIN operations.`,
      recommendation:
        "Check right-side cardinality and join algorithm with representative data; EXPLAIN alone does not prove runtime cost."
    });
  }
  if (query.selectsAllColumns) {
    findings.push({
      confidence: "advisory",
      severity: "low",
      code: "select-star",
      message: "SELECT * may read columns the caller does not need.",
      recommendation: "Project only required columns for repeated or high-volume queries."
    });
  }
  if (explain.tables.length === 0) {
    findings.push({
      confidence: "advisory",
      severity: "low",
      code: "no-mergetree-evidence",
      message: "EXPLAIN returned no MergeTree index evidence.",
      recommendation:
        "The query may be optimized away, use another engine, or read remotely; no pruning verdict is available."
    });
  }
  return findings;
}

function findIndex(
  table: TableExplainEvidence,
  type: IndexEvidence["type"]
): IndexEvidence | undefined {
  return table.indexes.find((index) => index.type === type);
}

function selectsEverything(ratio: { selected: number; total: number }): boolean {
  return ratio.total > 0 && ratio.selected === ratio.total;
}

function formatRatio(ratio: { selected: number; total: number }): string {
  return `${ratio.selected}/${ratio.total}`;
}
