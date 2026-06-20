import type { ClickHouseMetadataClient } from "./client.js";
import {
  formatTableIdentifier,
  parseTableIdentifier,
  resolveTableIdentifier,
  type ResolvedTableIdentifier
} from "./identifier.js";

export interface TableInspectionOptions {
  table: string;
  defaultDatabase: string;
}

export interface TableColumn {
  name: string;
  type: string;
  defaultKind?: string;
  defaultExpression?: string;
  codecExpression?: string;
}

export interface TablePartsSummary {
  activeParts: number;
  rows: number;
  bytesOnDisk: number;
  partitions: number;
}

export interface ReplacingMergeTreeDetails {
  versionColumn?: string;
  deletedColumn?: string;
}

export interface TableInspection {
  identifier: ResolvedTableIdentifier;
  engine: string;
  engineFull: string;
  createStatement: string;
  orderBy?: string;
  partitionBy?: string;
  primaryKey?: string;
  sortingKey?: string;
  totalRows: number;
  totalBytes: number;
  isDistributed: boolean;
  isReplacingMergeTree: boolean;
  replacingMergeTree?: ReplacingMergeTreeDetails;
  columns: TableColumn[];
  parts: TablePartsSummary;
  eligibleChecks: {
    verifyDedup: boolean;
    dryRunMigration: boolean;
    diagnoseQuery: boolean;
  };
  warnings: string[];
}

interface ShowCreateRow {
  statement: string;
}

interface SystemTableRow {
  engine: string;
  engine_full: string;
  sorting_key: string;
  primary_key: string;
  partition_key: string;
  total_rows: string | number;
  total_bytes: string | number;
}

interface SystemColumnRow {
  name: string;
  type: string;
  default_kind: string;
  default_expression: string;
  codec_expression: string;
}

interface PartsSummaryRow {
  active_parts: string | number;
  rows: string | number;
  bytes_on_disk: string | number;
  partitions: string | number;
}

export async function inspectTable(
  client: ClickHouseMetadataClient,
  options: TableInspectionOptions
): Promise<TableInspection> {
  const identifier = resolveTableIdentifier(
    parseTableIdentifier(options.table),
    options.defaultDatabase
  );
  const fullTableName = formatTableIdentifier(identifier);
  const databaseLiteral = quoteStringLiteral(identifier.database);
  const tableLiteral = quoteStringLiteral(identifier.table);

  const [showCreateRows, tableRows, columns, partsRows] = await Promise.all([
    client.queryJson<ShowCreateRow>(`SHOW CREATE TABLE ${fullTableName}`),
    client.queryJson<SystemTableRow>(`
      SELECT
        engine,
        engine_full,
        sorting_key,
        primary_key,
        partition_key,
        total_rows,
        total_bytes
      FROM system.tables
      WHERE database = ${databaseLiteral}
        AND name = ${tableLiteral}
      LIMIT 1
    `),
    client.queryJson<SystemColumnRow>(`
      SELECT
        name,
        type,
        default_kind,
        default_expression,
        compression_codec AS codec_expression
      FROM system.columns
      WHERE database = ${databaseLiteral}
        AND table = ${tableLiteral}
      ORDER BY position
    `),
    client.queryJson<PartsSummaryRow>(`
      SELECT
        count() AS active_parts,
        sum(rows) AS rows,
        sum(bytes_on_disk) AS bytes_on_disk,
        uniqExact(partition) AS partitions
      FROM system.parts
      WHERE database = ${databaseLiteral}
        AND table = ${tableLiteral}
        AND active
    `)
  ]);

  const [showCreate] = showCreateRows;
  const [table] = tableRows;
  const [parts] = partsRows;

  if (!table) {
    throw new Error(`Table not found: ${identifier.database}.${identifier.table}`);
  }

  const createStatement = showCreate?.statement ?? "";
  const engineFull = table.engine_full || table.engine;
  const isReplacingMergeTree = table.engine.includes("ReplacingMergeTree");
  const isDistributed = table.engine === "Distributed";
  const warnings = buildWarnings(table.engine, isReplacingMergeTree, isDistributed);
  const replacingMergeTree = isReplacingMergeTree
    ? parseReplacingMergeTreeDetails(engineFull)
    : undefined;

  return {
    identifier,
    engine: table.engine,
    engineFull,
    createStatement,
    orderBy: extractClause(createStatement, "ORDER BY"),
    partitionBy: extractClause(createStatement, "PARTITION BY"),
    primaryKey: normalizeOptional(table.primary_key),
    sortingKey: normalizeOptional(table.sorting_key),
    totalRows: toNumber(table.total_rows),
    totalBytes: toNumber(table.total_bytes),
    isDistributed,
    isReplacingMergeTree,
    replacingMergeTree,
    columns: columns.map(toTableColumn),
    parts: {
      activeParts: toNumber(parts?.active_parts ?? 0),
      rows: toNumber(parts?.rows ?? 0),
      bytesOnDisk: toNumber(parts?.bytes_on_disk ?? 0),
      partitions: toNumber(parts?.partitions ?? 0)
    },
    eligibleChecks: {
      verifyDedup: isReplacingMergeTree && !isDistributed,
      dryRunMigration: true,
      diagnoseQuery: true
    },
    warnings
  };
}

export function extractClause(
  createStatement: string,
  clauseName: "ORDER BY" | "PARTITION BY"
): string | undefined {
  const index = createStatement.indexOf(clauseName);

  if (index === -1) {
    return undefined;
  }

  const start = index + clauseName.length;
  const rest = createStatement.slice(start).trim();
  const nextClauseIndex = findNextClauseIndex(rest);
  const rawClause =
    nextClauseIndex === -1 ? rest : rest.slice(0, nextClauseIndex).trim();

  return rawClause || undefined;
}

function findNextClauseIndex(input: string): number {
  const candidates = [
    "\nORDER BY",
    "\nPARTITION BY",
    "\nPRIMARY KEY",
    "\nSAMPLE BY",
    "\nTTL",
    "\nSETTINGS",
    "\nCOMMENT"
  ];

  const indexes = candidates
    .map((candidate) => input.indexOf(candidate))
    .filter((index) => index >= 0);

  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function parseReplacingMergeTreeDetails(
  engineFull: string
): ReplacingMergeTreeDetails {
  const match = engineFull.match(/ReplacingMergeTree\s*\(([^)]*)\)/);

  if (!match) {
    return {};
  }

  const args = match[1]
    .split(",")
    .map((arg) => arg.trim())
    .filter(Boolean);

  return {
    versionColumn: args[0],
    deletedColumn: args[1]
  };
}

function buildWarnings(
  engine: string,
  isReplacingMergeTree: boolean,
  isDistributed: boolean
): string[] {
  const warnings: string[] = [];

  if (isReplacingMergeTree) {
    warnings.push(
      "ReplacingMergeTree table: queries without FINAL may expose duplicate rows."
    );
  }

  if (isDistributed) {
    warnings.push(
      "Distributed table: local checks may be advisory until shard topology is inspected."
    );
  }

  if (!engine.includes("MergeTree") && !isDistributed) {
    warnings.push(`Unsupported or uncommon table engine for MVP checks: ${engine}.`);
  }

  return warnings;
}

function toTableColumn(row: SystemColumnRow): TableColumn {
  return {
    name: row.name,
    type: row.type,
    defaultKind: normalizeOptional(row.default_kind),
    defaultExpression: normalizeOptional(row.default_expression),
    codecExpression: normalizeOptional(row.codec_expression)
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
