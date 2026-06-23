import type { ClickHouseMetadataClient } from "./client.js";
import { toNumber } from "../shared/num.js";
import { quoteStringLiteral } from "./identifier.js";
import {
  formatTableIdentifier,
  resolveTableIdentifier,
  type ResolvedTableIdentifier
} from "./identifier.js";
import {
  parseMigrationStatement,
  type ParsedMigration
} from "./migration-parser.js";
import { inspectTable } from "./table-inspection.js";

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

export interface DryRunMigrationResult {
  parsed: ParsedMigration;
  identifier: ResolvedTableIdentifier;
  engine: string;
  footprint: MigrationFootprint;
  rewrite: MigrationRewriteEstimate;
  productionExecuted: false;
}

interface PredicateEstimateRow {
  matching_rows: string | number;
  affected_part_rows: string | number;
  affected_parts: string | number;
  affected_bytes: string | number;
}

export async function dryRunMigration(
  client: ClickHouseMetadataClient,
  options: DryRunMigrationOptions
): Promise<DryRunMigrationResult> {
  const parsed = parseMigrationStatement(options.statement);
  const identifier = resolveTableIdentifier(parsed.table, options.defaultDatabase);
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
  if (parsed.classification === "unsupported" || parsed.rewriteScope === "none") {
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

  return {
    parsed,
    identifier,
    engine: inspection.engineFull,
    footprint,
    rewrite,
    productionExecuted: false
  };
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


