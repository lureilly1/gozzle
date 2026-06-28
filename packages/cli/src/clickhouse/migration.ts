import type { ClickHouseMetadataClient } from "./client.js";
import { toNumber } from "../shared/num.js";
import { errorMessage } from "../shared/errors.js";
import { quoteIdentifier, quoteStringLiteral } from "./identifier.js";
import {
  formatTableIdentifier,
  resolveTableIdentifier,
  type ResolvedTableIdentifier
} from "./identifier.js";
import {
  parseMigrationStatement,
  type MigrationAssignment,
  type ParsedMigration
} from "./migration-parser.js";
import { maskQuoted } from "./sql-scan.js";
import { inspectTable, type TableInspection } from "./table-inspection.js";

export interface DryRunMigrationOptions {
  statement: string;
  defaultDatabase: string;
}

export interface MigrationFootprint {
  rows: number;
  activeParts: number;
  bytesOnDisk: number;
}

export interface MigrationRewriteEstimate {
  matchingRows: number;
  affectedPartRows: number;
  affectedParts: number;
  affectedBytes: number;
  evidence: "none" | "table-metadata-upper-bound" | "predicate-part-scan";
}

export type CorrectnessStatus = "ok" | "warning" | "error" | "unknown";

export interface CorrectnessFinding {
  /** Which check produced this (e.g. "cast-safety", "expression", "delete-scope"). */
  check: string;
  status: CorrectnessStatus;
  message: string;
}

export interface DryRunMigrationResult {
  parsed: ParsedMigration;
  identifier: ResolvedTableIdentifier;
  engine: string;
  footprint: MigrationFootprint;
  rewrite: MigrationRewriteEstimate;
  /**
   * Read-only correctness findings: whether the migration's expressions,
   * type changes, and predicate behave on the current data. Proven against the
   * live table without ever executing the ALTER. Empty when the operation has
   * nothing to check (e.g. metadata-only or unsupported).
   */
  correctness: CorrectnessFinding[];
  productionExecuted: false;
}

/** The worst status across findings, or "ok" when there is nothing to check. */
export function correctnessVerdict(
  findings: CorrectnessFinding[]
): CorrectnessStatus {
  const order: CorrectnessStatus[] = ["error", "warning", "unknown", "ok"];
  return (
    order.find((status) => findings.some((f) => f.status === status)) ?? "ok"
  );
}

interface PredicateEstimateRow {
  matching_rows: string | number;
  affected_part_rows: string | number;
  affected_parts: string | number;
  affected_bytes: string | number;
}

interface CastProbeRow {
  checked_rows: string | number;
  cast_failures: string | number;
  null_values: string | number;
}

export async function dryRunMigration(
  client: ClickHouseMetadataClient,
  options: DryRunMigrationOptions
): Promise<DryRunMigrationResult> {
  const parsed = parseMigrationStatement(options.statement);
  const identifier = resolveTableIdentifier(
    parsed.table,
    options.defaultDatabase
  );
  const inspection = await inspectTable(client, {
    table: `${identifier.database}.${identifier.table}`,
    defaultDatabase: options.defaultDatabase
  });
  const footprint: MigrationFootprint = {
    rows: inspection.totalRows,
    activeParts: inspection.parts.activeParts,
    bytesOnDisk: inspection.totalBytes
  };

  let rewrite: MigrationRewriteEstimate;
  if (
    parsed.classification === "unsupported" ||
    parsed.rewriteScope === "none"
  ) {
    rewrite = emptyEstimate();
  } else if (parsed.rewriteScope === "all") {
    rewrite = {
      matchingRows: inspection.totalRows,
      affectedPartRows: inspection.parts.rows,
      affectedParts: inspection.parts.activeParts,
      affectedBytes: inspection.parts.bytesOnDisk,
      evidence: "table-metadata-upper-bound"
    };
  } else {
    rewrite = await estimatePredicateMutation(
      client,
      identifier,
      parsed.predicate ?? "false"
    );
  }

  const correctness = await checkMigrationCorrectness(
    client,
    parsed,
    identifier,
    inspection,
    rewrite
  );

  return {
    parsed,
    identifier,
    engine: inspection.engineFull,
    footprint,
    rewrite,
    correctness,
    productionExecuted: false
  };
}

async function checkMigrationCorrectness(
  client: ClickHouseMetadataClient,
  parsed: ParsedMigration,
  identifier: ResolvedTableIdentifier,
  inspection: TableInspection,
  rewrite: MigrationRewriteEstimate
): Promise<CorrectnessFinding[]> {
  if (parsed.classification === "unsupported") return [];

  const findings: CorrectnessFinding[] = [];
  if (parsed.predicate) {
    findings.push({
      check: "predicate",
      status: "ok",
      message: `Predicate evaluated against current data; ${rewrite.matchingRows} row(s) matched.`
    });
  }

  for (const assignment of parsed.assignments ?? []) {
    findings.push(
      await checkAssignment(client, identifier, inspection, assignment, parsed)
    );
  }

  if (parsed.columnChange) {
    findings.push(
      await checkColumnChange(
        client,
        identifier,
        inspection,
        parsed.columnChange
      )
    );
  }

  if (parsed.columnExpression) {
    findings.push(await checkColumnExpression(client, identifier, parsed));
  }

  return findings;
}

async function checkAssignment(
  client: ClickHouseMetadataClient,
  identifier: ResolvedTableIdentifier,
  inspection: TableInspection,
  assignment: MigrationAssignment,
  parsed: ParsedMigration
): Promise<CorrectnessFinding> {
  const column = inspection.columns.find(
    (entry) => entry.name === assignment.column
  );
  if (!column) {
    return {
      check: "update-expression",
      status: "error",
      message: `UPDATE assignment targets missing column ${assignment.column}.`
    };
  }

  const unsafe = unsafeReadExpressionReason(assignment.expression);
  if (unsafe) {
    return {
      check: "update-expression",
      status: "error",
      message: `UPDATE expression for ${assignment.column} was not executed: ${unsafe}.`
    };
  }

  return runCastProbe(client, {
    check: "update-expression",
    identifier,
    expression: assignment.expression,
    targetType: column.type,
    predicate: parsed.predicate,
    subject: `UPDATE expression for ${assignment.column}`
  });
}

async function checkColumnChange(
  client: ClickHouseMetadataClient,
  identifier: ResolvedTableIdentifier,
  inspection: TableInspection,
  columnChange: NonNullable<ParsedMigration["columnChange"]>
): Promise<CorrectnessFinding> {
  const column = inspection.columns.find(
    (entry) => entry.name === columnChange.column
  );
  if (!column) {
    return {
      check: "cast-safety",
      status: "error",
      message: `MODIFY COLUMN targets missing column ${columnChange.column}.`
    };
  }

  return runCastProbe(client, {
    check: "cast-safety",
    identifier,
    expression: quoteIdentifier(columnChange.column),
    targetType: columnChange.type,
    subject: `Existing values in ${columnChange.column}`
  });
}

async function checkColumnExpression(
  client: ClickHouseMetadataClient,
  identifier: ResolvedTableIdentifier,
  parsed: ParsedMigration
): Promise<CorrectnessFinding> {
  const columnExpression = parsed.columnExpression;
  if (!columnExpression) {
    return {
      check: "column-expression",
      status: "unknown",
      message: "No column expression was available to validate."
    };
  }
  const unsafe = unsafeReadExpressionReason(columnExpression.expression);
  if (unsafe) {
    return {
      check: "column-expression",
      status: "error",
      message: `${columnExpression.kind} expression for ${columnExpression.column} was not executed: ${unsafe}.`
    };
  }

  return runCastProbe(client, {
    check: "column-expression",
    identifier,
    expression: columnExpression.expression,
    targetType: columnExpression.type,
    subject: `${columnExpression.kind} expression for ${columnExpression.column}`
  });
}

async function runCastProbe(
  client: ClickHouseMetadataClient,
  options: {
    check: string;
    identifier: ResolvedTableIdentifier;
    expression: string;
    targetType: string;
    predicate?: string;
    subject: string;
  }
): Promise<CorrectnessFinding> {
  const targetTypeLiteral = quoteStringLiteral(options.targetType);
  const where = options.predicate ? `WHERE (${options.predicate})` : "";
  const tableName = formatTableIdentifier(options.identifier);
  const nullableTarget = allowsNullType(options.targetType);
  try {
    const [row] = await client.queryJson<CastProbeRow>(`
      SELECT
        count() AS checked_rows,
        countIf(isNull(accurateCastOrNull(__gozzle_value, ${targetTypeLiteral})) AND __gozzle_value IS NOT NULL) AS cast_failures,
        countIf(isNull(__gozzle_value)) AS null_values
      FROM (
        SELECT ${options.expression} AS __gozzle_value
        FROM ${tableName}
        ${where}
      )
    `);
    const checkedRows = toNumber(row?.checked_rows ?? 0);
    const castFailures = toNumber(row?.cast_failures ?? 0);
    const nullValues = toNumber(row?.null_values ?? 0);
    const totalFailures = castFailures + (nullableTarget ? 0 : nullValues);
    if (totalFailures > 0) {
      const nullMessage =
        !nullableTarget && nullValues > 0
          ? `, including ${nullValues} NULL value(s) for a non-Nullable target`
          : "";
      return {
        check: options.check,
        status: "error",
        message: `${options.subject} failed conversion to ${options.targetType} for ${totalFailures} current row(s)${nullMessage}.`
      };
    }
    return {
      check: options.check,
      status: "ok",
      message: `${options.subject} converted to ${options.targetType} for ${checkedRows} current row(s).`
    };
  } catch (error) {
    return {
      check: options.check,
      status: "error",
      message: `${options.subject} could not be proven against current data: ${errorMessage(error)}`
    };
  }
}

async function estimatePredicateMutation(
  client: ClickHouseMetadataClient,
  identifier: ResolvedTableIdentifier,
  predicate: string
): Promise<MigrationRewriteEstimate> {
  const tableName = formatTableIdentifier(identifier);
  const database = quoteStringLiteral(identifier.database);
  const table = quoteStringLiteral(identifier.table);
  const [row] = await client.queryJson<PredicateEstimateRow>(`
    SELECT
      coalesce(sum(affected.matching_rows), 0) AS matching_rows,
      coalesce(sum(parts.rows), 0) AS affected_part_rows,
      count() AS affected_parts,
      coalesce(sum(parts.bytes_on_disk), 0) AS affected_bytes
    FROM system.parts AS parts
    INNER JOIN (
      SELECT _part AS part_name, count() AS matching_rows
      FROM ${tableName}
      WHERE (${predicate})
      GROUP BY _part
    ) AS affected ON parts.name = affected.part_name
    WHERE parts.database = ${database}
      AND parts.table = ${table}
      AND parts.active
  `);

  return {
    matchingRows: toNumber(row?.matching_rows ?? 0),
    affectedPartRows: toNumber(row?.affected_part_rows ?? 0),
    affectedParts: toNumber(row?.affected_parts ?? 0),
    affectedBytes: toNumber(row?.affected_bytes ?? 0),
    evidence: "predicate-part-scan"
  };
}

function emptyEstimate(): MigrationRewriteEstimate {
  return {
    matchingRows: 0,
    affectedPartRows: 0,
    affectedParts: 0,
    affectedBytes: 0,
    evidence: "none"
  };
}

function allowsNullType(type: string): boolean {
  const normalized = type.replace(/\s+/g, "");
  if (/^Nullable\(/i.test(normalized)) return true;
  const lowCardinality = normalized.match(/^LowCardinality\((.*)\)$/i);
  return lowCardinality ? allowsNullType(lowCardinality[1]) : false;
}

function unsafeReadExpressionReason(expression: string): string | undefined {
  const masked = maskQuoted(expression);
  if (/\bSELECT\b/i.test(masked)) {
    return "subqueries are not permitted in production validation reads";
  }
  const external = masked.match(
    /\b(url|urlCluster|remote|remoteSecure|cluster|clusterAllReplicas|file|filesystem|s3|s3Cluster|hdfs|hdfsCluster|azureBlobStorage|azureBlobStorageCluster|gcs|iceberg|deltaLake|hudi|mysql|postgresql|mongodb|redis|sqlite|odbc|jdbc|executable|executablePool)\s*\(/i
  );
  if (external) {
    return `external-access function ${external[1]}() is not permitted in production validation reads`;
  }
  return undefined;
}
