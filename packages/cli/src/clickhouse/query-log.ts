import type { ClickHouseMetadataClient } from "./client.js";

export interface WorkloadQuery {
  hash: string;
  sampleQuery: string;
  runs: number;
  totalReadBytes: number;
  totalDurationMs: number;
  tables: string[];
  /** Subset of `tables` whose engine is a ReplacingMergeTree family engine. */
  replacingTables: string[];
}

export interface DiscoverWorkloadOptions {
  defaultDatabase: string;
  sinceDays?: number;
  limit?: number;
}

interface RawWorkloadRow {
  hash: string;
  sample_query: string;
  runs: string | number;
  total_read_bytes: string | number;
  total_duration_ms: string | number;
  query_tables: string[];
}

interface EngineRow {
  qualified: string;
  engine: string;
}

const DEFAULT_SINCE_DAYS = 7;
const DEFAULT_LIMIT = 20;

/**
 * One-shot, read-only import of recent SELECTs from system.query_log, grouped by
 * normalized query, ranked by bytes read, and flagged where they touch a
 * ReplacingMergeTree table. This is discovery, not monitoring: nothing is
 * retained.
 */
export async function discoverWorkload(
  client: ClickHouseMetadataClient,
  options: DiscoverWorkloadOptions
): Promise<WorkloadQuery[]> {
  const sinceDays = clampInt(options.sinceDays, DEFAULT_SINCE_DAYS);
  const limit = clampInt(options.limit, DEFAULT_LIMIT);

  const rows = await client.queryJson<RawWorkloadRow>(`
    SELECT
      toString(normalized_query_hash) AS hash,
      any(normalizeQuery(query)) AS sample_query,
      count() AS runs,
      sum(read_bytes) AS total_read_bytes,
      sum(query_duration_ms) AS total_duration_ms,
      arrayDistinct(arrayFlatten(groupArray(tables))) AS query_tables
    FROM system.query_log
    WHERE type = 'QueryFinish'
      AND query_kind = 'Select'
      AND is_initial_query
      AND event_time > now() - toIntervalDay(${sinceDays})
      -- Keep only queries that touch a real user table. This drops the platform's
      -- own internal scrapers (system.*, information_schema, table functions),
      -- which otherwise dominate the ranking on ClickHouse Cloud.
      AND length(tables) > 0
      AND arrayExists(
        t -> splitByChar('.', t)[1] NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
          AND NOT startsWith(t, '_table_function'),
        tables
      )
    GROUP BY normalized_query_hash
    ORDER BY total_read_bytes DESC
    LIMIT ${limit}
  `);

  const engines = await readEngines(client, rows, options.defaultDatabase);

  return rows.map((row) => {
    const tables = Array.isArray(row.query_tables) ? row.query_tables : [];
    return {
      hash: row.hash,
      sampleQuery: row.sample_query,
      runs: toNumber(row.runs),
      totalReadBytes: toNumber(row.total_read_bytes),
      totalDurationMs: toNumber(row.total_duration_ms),
      tables,
      replacingTables: tables.filter((table) =>
        (engines.get(qualify(table, options.defaultDatabase)) ?? "").includes(
          "ReplacingMergeTree"
        )
      )
    };
  });
}

async function readEngines(
  client: ClickHouseMetadataClient,
  rows: RawWorkloadRow[],
  defaultDatabase: string
): Promise<Map<string, string>> {
  const distinct = [
    ...new Set(
      rows.flatMap((row) =>
        Array.isArray(row.query_tables) ? row.query_tables : []
      )
    )
  ];
  if (distinct.length === 0) return new Map();

  const pairs = distinct
    .map((table) => {
      const { database, name } = splitTable(table, defaultDatabase);
      return `(${quoteStringLiteral(database)}, ${quoteStringLiteral(name)})`;
    })
    .join(", ");

  const engineRows = await client.queryJson<EngineRow>(`
    SELECT concat(database, '.', name) AS qualified, engine
    FROM system.tables
    WHERE (database, name) IN (${pairs})
  `);

  return new Map(engineRows.map((row) => [row.qualified, row.engine]));
}

function splitTable(
  table: string,
  defaultDatabase: string
): { database: string; name: string } {
  const dot = table.indexOf(".");
  if (dot === -1) return { database: defaultDatabase, name: table };
  return { database: table.slice(0, dot), name: table.slice(dot + 1) };
}

function qualify(table: string, defaultDatabase: string): string {
  const { database, name } = splitTable(table, defaultDatabase);
  return `${database}.${name}`;
}

function clampInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
