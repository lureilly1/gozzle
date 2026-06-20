import type { ClickHouseMetadataClient } from "./client.js";
import {
  formatTableIdentifier,
  type ResolvedTableIdentifier
} from "./identifier.js";
import { inspectTable } from "./table-inspection.js";

export interface VerifyDedupOptions {
  table: string;
  defaultDatabase: string;
  /** Maximum number of duplicated keys to return as evidence. */
  sampleLimit?: number;
  /** Restrict proof to one physical partition, matching local slice scope. */
  partitionId?: string;
}

export interface DedupSampleRow {
  partitionId: string;
  key: Record<string, unknown>;
  copies: number;
}

export interface VerifyDedupResult {
  identifier: ResolvedTableIdentifier;
  engine: string;
  sortingKey?: string;
  partitionBy?: string;
  isPartitioned: boolean;
  eligible: boolean;
  reason?: string;
  totalRows: number;
  duplicateGroups: number;
  /**
   * Rows that background merges will collapse: duplicates that share a sorting
   * key *within the same partition*. This is the physical, eventual floor.
   */
  duplicateRows: number;
  /**
   * Rows that `SELECT ... FINAL` collapses: duplicates by sorting key across
   * the whole scope (ClickHouse deduplicates globally by default). For a
   * single partition this equals `duplicateRows`; for a multi-partition table
   * it can be larger because cross-partition duplicates are never merged.
   */
  finalCollapsibleRows: number;
  maxCopies: number;
  sample: DedupSampleRow[];
  warnings: string[];
}

interface DedupAggregateRow {
  duplicate_groups: string | number;
  duplicate_rows: string | number;
  max_copies: string | number;
}

const DEFAULT_SAMPLE_LIMIT = 5;

export async function verifyDedup(
  client: ClickHouseMetadataClient,
  options: VerifyDedupOptions
): Promise<VerifyDedupResult> {
  const inspection = await inspectTable(client, {
    table: options.table,
    defaultDatabase: options.defaultDatabase
  });

  const base = {
    identifier: inspection.identifier,
    engine: inspection.engine,
    sortingKey: inspection.sortingKey,
    partitionBy: inspection.partitionBy,
    isPartitioned: Boolean(inspection.partitionBy),
    totalRows: inspection.totalRows,
    duplicateGroups: 0,
    duplicateRows: 0,
    finalCollapsibleRows: 0,
    maxCopies: 0,
    sample: [] as DedupSampleRow[],
    warnings: [] as string[]
  };

  if (inspection.isDistributed) {
    return {
      ...base,
      eligible: false,
      reason:
        "Distributed table: run verify_dedup against the underlying local ReplacingMergeTree table on each shard."
    };
  }

  if (!inspection.isReplacingMergeTree) {
    return {
      ...base,
      eligible: false,
      reason: `Engine ${inspection.engine} is not a ReplacingMergeTree family engine, so ClickHouse never deduplicates rows by sorting key.`
    };
  }

  if (!inspection.sortingKey) {
    return {
      ...base,
      eligible: false,
      reason: "Table has no sorting key, so there is no dedup key to check."
    };
  }

  const fullTableName = formatTableIdentifier(inspection.identifier);
  const sortingKey = inspection.sortingKey;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const partitionFilter = options.partitionId
    ? `WHERE _partition_id = ${quoteStringLiteral(options.partitionId)}`
    : "";

  // Background merges (and FINAL) collapse rows that share a sorting key within
  // the same partition. Grouping by `_partition_id` plus the sorting key gives
  // exactly the set of rows ClickHouse will eventually merge away.
  const [aggregate] = await client.queryJson<DedupAggregateRow>(`
    SELECT
      count() AS duplicate_groups,
      sum(copies - 1) AS duplicate_rows,
      max(copies) AS max_copies
    FROM (
      SELECT count() AS copies
      FROM ${fullTableName}
      ${partitionFilter}
      GROUP BY _partition_id, ${sortingKey}
      HAVING copies > 1
    )
  `);

  const duplicateGroups = toNumber(aggregate?.duplicate_groups ?? 0);
  const duplicateRows = toNumber(aggregate?.duplicate_rows ?? 0);
  const maxCopies = toNumber(aggregate?.max_copies ?? 0);

  // What `SELECT ... FINAL` would collapse: duplicates by sorting key across the
  // whole scope, ignoring partitions (ClickHouse deduplicates globally by
  // default, `do_not_merge_across_partitions_select_final=0`).
  const [globalRow] = await client.queryJson<{ final_dups: string | number }>(`
    SELECT count() - uniqExact(${sortingKey}) AS final_dups
    FROM ${fullTableName}
    ${partitionFilter}
  `);
  const finalCollapsibleRows = toNumber(globalRow?.final_dups ?? 0);

  const sample =
    duplicateGroups > 0
      ? await readSample(
          client,
          fullTableName,
          sortingKey,
          sampleLimit,
          partitionFilter
        )
      : [];

  const warnings: string[] = [];
  if (base.isPartitioned && finalCollapsibleRows !== duplicateRows) {
    warnings.push(
      `${finalCollapsibleRows - duplicateRows} of the FINAL-collapsible rows are cross-partition duplicates that background merges never remove.`
    );
  }

  return {
    ...base,
    eligible: true,
    duplicateGroups,
    duplicateRows,
    finalCollapsibleRows,
    maxCopies,
    sample,
    warnings
  };
}

async function readSample(
  client: ClickHouseMetadataClient,
  fullTableName: string,
  sortingKey: string,
  sampleLimit: number,
  partitionFilter: string
): Promise<DedupSampleRow[]> {
  const rows = await client.queryJson<Record<string, unknown>>(`
    SELECT
      _partition_id AS _partition_id,
      ${sortingKey},
      count() AS _copies
    FROM ${fullTableName}
    ${partitionFilter}
    GROUP BY _partition_id, ${sortingKey}
    HAVING _copies > 1
    ORDER BY _copies DESC
    LIMIT ${sampleLimit}
  `);

  return rows.map((row) => {
    const { _partition_id, _copies, ...key } = row;
    return {
      partitionId: String(_partition_id ?? ""),
      key,
      copies: toNumber((_copies as string | number) ?? 0)
    };
  });
}

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
