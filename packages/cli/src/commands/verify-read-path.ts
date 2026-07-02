import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import type { DiagnoseQueryResult } from "../clickhouse/query-diagnosis.js";
import { verifyDedup } from "../clickhouse/dedup.js";
import type {
  GozzleProjectConfig,
  TableAssumption
} from "../config/project.js";
import { readDedupScanGuard } from "../tools/verify-dedup.js";
import { formatCount } from "../shared/format.js";

export interface ReadPathOutcome {
  table: string;
  uniqueBy: string[];
  status: "violated" | "clean" | "unknown";
  duplicateRows: number;
  message: string;
}

/**
 * The read-path proof: for each table the query reads that is declared unique
 * (gozzle.yaml assumptions) and is read without FINAL, check whether current
 * data actually violates that uniqueness, turning "duplicates exist" into
 * "this query can overcount."
 */
export async function checkReadPaths(
  client: ClickHouseMetadataClient,
  result: DiagnoseQueryResult,
  config: GozzleProjectConfig | undefined,
  defaultDatabase: string,
  env: NodeJS.ProcessEnv
): Promise<ReadPathOutcome[]> {
  if (!config || result.query.hasFinal) return [];

  const guard = readDedupScanGuard(env);
  const outcomes: ReadPathOutcome[] = [];
  for (const table of result.explain.tables) {
    const assumption = findAssumption(config, table.table);
    if (!assumption?.uniqueBy || assumption.uniqueBy.length === 0) continue;

    let dedup;
    try {
      dedup = await verifyDedup(client, {
        table: table.table,
        defaultDatabase,
        maxScanRows: guard.maxScanRows,
        maxScanBytes: guard.maxScanBytes
      });
    } catch {
      continue; // cannot prove this table; leave it out rather than guess
    }
    if (!dedup.eligible) continue;

    const keys = assumption.uniqueBy.join(", ");
    // The proof scans for duplicates by the table's sorting key (that is what
    // ReplacingMergeTree deduplicates by). If the declared unique_by names a
    // different key, the proof would report evidence about a key the user never
    // claimed, so refuse to bind them instead of guessing.
    if (!sameColumnSet(assumption.uniqueBy, dedup.sortingKey ?? "")) {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "unknown",
        duplicateRows: 0,
        message: `${table.table} is declared unique by (${keys}), but its dedup (sorting) key is (${dedup.sortingKey ?? "none"}). gozzle proves duplicates by sorting key; update unique_by to match the table's ORDER BY.`
      });
      continue;
    }
    if (dedup.scanSkipped) {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "unknown",
        duplicateRows: 0,
        message: `${table.table} is too large to confirm; it is declared unique by (${keys}) and read without FINAL.`
      });
    } else if (dedup.finalCollapsibleRows > 0) {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "violated",
        duplicateRows: dedup.finalCollapsibleRows,
        message: `${table.table} is read without FINAL and trusted as unique by (${keys}), but currently has ${formatCount(dedup.finalCollapsibleRows)} duplicate row(s) by sorting key. This query can overcount.`
      });
    } else {
      outcomes.push({
        table: table.table,
        uniqueBy: assumption.uniqueBy,
        status: "clean",
        duplicateRows: 0,
        message: `${table.table} is declared unique by (${keys}) and currently has no duplicates.`
      });
    }
  }
  return outcomes;
}

/** Order-insensitive comparison of unique_by columns to a sorting-key string. */
function sameColumnSet(uniqueBy: string[], sortingKey: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^`(.*)`$/, "$1")
      .toLowerCase();
  const declared = new Set(uniqueBy.map(normalize));
  const key = sortingKey
    .split(",")
    .map(normalize)
    .filter((column) => column !== "");
  return key.length === declared.size && key.every((c) => declared.has(c));
}

function findAssumption(
  config: GozzleProjectConfig,
  explainTable: string
): TableAssumption | undefined {
  if (config.assumptions[explainTable]) return config.assumptions[explainTable];
  const bare = explainTable.includes(".")
    ? explainTable.slice(explainTable.lastIndexOf(".") + 1)
    : explainTable;
  return config.assumptions[bare];
}

export function formatReadPaths(items: ReadPathOutcome[]): string {
  if (items.length === 0) return "";
  return [
    "Read-path proof:",
    ...items.map((it) => `- [${it.status}] ${it.message}`)
  ].join("\n");
}
