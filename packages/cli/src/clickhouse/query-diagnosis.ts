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
import { inspectTable } from "./table-inspection.js";

export interface QueryFinding {
  confidence: "proven" | "advisory";
  severity: "high" | "medium" | "low";
  code: string;
  message: string;
  evidence?: string;
  recommendation: string;
}

/** Key layout for a table the query reads, so a fix can be made concrete. */
export interface QueryTableSchema {
  table: string;
  orderBy?: string;
  partitionBy?: string;
  totalRows?: number;
  totalBytes?: number;
}

export interface DiagnoseQueryResult {
  query: ValidatedQuery;
  explain: ExplainEvidence;
  tableSchemas: QueryTableSchema[];
  findings: QueryFinding[];
  originalQueryExecuted: false;
}

// A proven full scan blocks the gate only above this size; below it the
// finding is still reported, but as a non-blocking warning.
const FULL_SCAN_BLOCKING_ROWS = 10_000_000;
const FULL_SCAN_BLOCKING_BYTES = 1024 * 1024 * 1024;

export async function diagnoseQuery(
  client: ClickHouseMetadataClient,
  query: string,
  defaultDatabase = "default"
): Promise<DiagnoseQueryResult> {
  const validated = validateDiagnosticQuery(query);
  const rows = await client.queryJson<ExplainRow>(`
    EXPLAIN indexes = 1, projections = 1
    ${validated.query}
  `);
  const explain = parseExplainRows(rows);
  const tableSchemas = await readTableSchemas(
    client,
    explain.tables,
    defaultDatabase
  );
  const findings = [
    ...explain.tables.flatMap((table) =>
      diagnoseTable(
        table,
        tableSchemas.find((schema) => schema.table === table.table)
      )
    ),
    ...buildAdvisories(validated, explain)
  ];

  return {
    query: validated,
    explain,
    tableSchemas,
    findings,
    originalQueryExecuted: false
  };
}

/**
 * Fetch the ORDER BY / PARTITION BY for each table the plan reads, so findings
 * can name the actual keys. Best-effort: a table that can't be inspected (CTE,
 * non-MergeTree, missing) simply has no schema attached.
 */
async function readTableSchemas(
  client: ClickHouseMetadataClient,
  tables: TableExplainEvidence[],
  defaultDatabase: string
): Promise<QueryTableSchema[]> {
  const schemas: QueryTableSchema[] = [];
  for (const table of tables) {
    try {
      const inspection = await inspectTable(client, {
        table: table.table,
        defaultDatabase
      });
      schemas.push({
        table: table.table,
        orderBy: inspection.orderBy ?? inspection.sortingKey,
        partitionBy: inspection.partitionBy,
        totalRows: inspection.totalRows,
        totalBytes: inspection.totalBytes
      });
    } catch {
      schemas.push({ table: table.table });
    }
  }
  return schemas;
}

function diagnoseTable(
  table: TableExplainEvidence,
  schema?: QueryTableSchema
): QueryFinding[] {
  const findings: QueryFinding[] = [];
  const orderByHint = schema?.orderBy
    ? ` This table's ORDER BY is (${schema.orderBy}).`
    : "";
  const partitionHint = schema?.partitionBy
    ? ` This table's PARTITION BY is (${schema.partitionBy}).`
    : "";
  const minMax = findIndex(table, "MinMax");
  const partition = findIndex(table, "Partition");
  const primary = findIndex(table, "PrimaryKey");
  const baseParts = minMax?.parts ?? partition?.parts ?? primary?.parts;
  const finalGranules =
    primary?.granules ?? partition?.granules ?? minMax?.granules;

  if (
    baseParts &&
    finalGranules &&
    selectsEverything(baseParts) &&
    selectsEverything(finalGranules)
  ) {
    // A full scan of a small table is often the intent (whole-table
    // aggregates); only a large table makes it a blocking regression. When the
    // size is unknown, stay conservative and treat it as large.
    const small =
      schema?.totalRows !== undefined &&
      schema.totalRows < FULL_SCAN_BLOCKING_ROWS &&
      (schema.totalBytes ?? 0) < FULL_SCAN_BLOCKING_BYTES;
    const sizeNote =
      schema?.totalRows !== undefined
        ? `, table has ${schema.totalRows} row(s)`
        : "";
    findings.push({
      confidence: "proven",
      severity: small ? "medium" : "high",
      code: "full-scan",
      message: `${table.table} scans every reported part and granule.`,
      evidence: `parts ${formatRatio(baseParts)}, granules ${formatRatio(finalGranules)}${sizeNote}`,
      recommendation: `Align filters with the partition or leading ORDER BY keys, or evaluate a projection for this access pattern.${partitionHint}${orderByHint}`
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
      recommendation: `Filter on the partition expression with a compatible range when the query should target fewer partitions.${partitionHint}`
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
      recommendation: `Filter on a useful prefix of the ORDER BY key without wrapping key columns in incompatible functions.${orderByHint}`
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
      message:
        "A leading-wildcard LIKE predicate usually cannot use ordered-key ranges.",
      recommendation:
        "Consider a text index or a different predicate shape for substring search."
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
      recommendation:
        "Project only required columns for repeated or high-volume queries."
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

function selectsEverything(ratio: {
  selected: number;
  total: number;
}): boolean {
  return ratio.total > 0 && ratio.selected === ratio.total;
}

function formatRatio(ratio: { selected: number; total: number }): string {
  return `${ratio.selected}/${ratio.total}`;
}
