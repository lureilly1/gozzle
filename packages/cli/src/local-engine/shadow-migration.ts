import type { ClickHouseExportClient } from "../clickhouse/client.js";
import { verifyDedup } from "../clickhouse/dedup.js";
import {
  quoteIdentifier,
  resolveTableIdentifier
} from "../clickhouse/identifier.js";
import { parseMigrationStatement } from "../clickhouse/migration-parser.js";
import type {
  EphemeralSliceConfig,
  LocalSliceConfig
} from "../config/local-slice.js";
import { errorMessage } from "../shared/errors.js";
import { toNumber } from "../shared/num.js";
import { withEphemeralSlice } from "./ephemeral-slice.js";
import type { LocalEngine } from "./types.js";

export interface ShadowMigrationOptions {
  statement: string;
  partitionId: string;
  defaultDatabase: string;
}

export interface ShadowMigrationSnapshot {
  rows: number;
  duplicateGroups: number;
  duplicateRows: number;
  maxCopies: number;
}

export interface ShadowMigrationResult {
  engine: string;
  table: string;
  partitionId: string;
  operation: "UPDATE" | "DELETE";
  /** Rows in the replayed slice before execution. */
  sliceRows: number;
  /** Rows matching the mutation predicate, measured before execution. */
  matchedRows: number;
  /**
   * Whether ClickHouse accepted and ran the exact ALTER against the slice. When
   * false, `executionError` carries the engine's rejection (e.g. "Cannot UPDATE
   * key column"). This is the signal a read-only estimate cannot produce: proof
   * that the real statement runs, not an inference that it should.
   */
  executed: boolean;
  executionError?: string;
  /** Rows physically removed (DELETE only; 0 for UPDATE or a rejected run). */
  rowsDeleted: number;
  /** The exact statement executed against the local slice. */
  executedStatement: string;
  before: ShadowMigrationSnapshot;
  /** Post-execution snapshot; equal to `before` when the mutation was rejected. */
  after: ShadowMigrationSnapshot;
  productionExecuted: false;
}

/** Thrown when a statement is not eligible for chDB shadow execution. */
export class ShadowMigrationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowMigrationUnsupportedError";
  }
}

/**
 * Replay one complete partition into an ephemeral chDB slice, actually execute
 * the ALTER mutation against it, and measure the real before/after effect. This
 * proves what a read-only estimate cannot: that the mutation runs, how many rows
 * it changes, and whether it preserves the table's deduplication invariant — all
 * without ever executing the ALTER on production.
 */
export async function shadowExecuteMigration(
  source: ClickHouseExportClient,
  localEngine: LocalEngine,
  options: ShadowMigrationOptions,
  localSliceConfig: LocalSliceConfig,
  ephemeralConfig: EphemeralSliceConfig
): Promise<ShadowMigrationResult> {
  const parsed = parseMigrationStatement(options.statement);
  if (
    parsed.classification !== "part-rewriting" ||
    parsed.rewriteScope !== "predicate" ||
    !parsed.predicate
  ) {
    throw new ShadowMigrationUnsupportedError(
      `Shadow execution supports predicate UPDATE and DELETE mutations only; this statement is ${parsed.classification}.`
    );
  }

  const identifier = resolveTableIdentifier(
    parsed.table,
    options.defaultDatabase
  );
  const operation: "UPDATE" | "DELETE" = /^UPDATE\b/i.test(parsed.operation)
    ? "UPDATE"
    : "DELETE";
  const localTable = `gozzle_slice.${quoteIdentifier(identifier.table)}`;

  return withEphemeralSlice(
    {
      source,
      localEngine,
      slice: {
        table: `${identifier.database}.${identifier.table}`,
        partitionId: options.partitionId,
        defaultDatabase: options.defaultDatabase
      },
      localSliceConfig,
      ephemeralConfig
    },
    async (slice) => {
      const client = await localEngine.open(slice.workspacePath);
      try {
        const before = await snapshot(client, identifier.table);
        const matchedRows = await countMatching(
          client,
          localTable,
          parsed.predicate as string
        );

        // The user's operation targets the production table; retarget it at the
        // replayed slice, keeping the exact operation text they wrote. Force
        // synchronous mutation so the effect is observable immediately after.
        const executedStatement = `ALTER TABLE ${localTable} ${parsed.operation}`;
        await client.queryJson("SET mutations_sync = 1");

        let executed = true;
        let executionError: string | undefined;
        try {
          await client.queryJson(executedStatement);
        } catch (error) {
          // A rejection is a real, reportable correctness finding, not a
          // failure of the tool. ClickHouse refusing the ALTER against faithful
          // data is exactly what shadow execution exists to catch.
          executed = false;
          executionError = errorMessage(error);
        }

        const after = executed
          ? await snapshot(client, identifier.table)
          : before;
        return {
          engine: localEngine.name,
          table: `${identifier.database}.${identifier.table}`,
          partitionId: options.partitionId,
          operation,
          sliceRows: before.rows,
          matchedRows,
          executed,
          executionError,
          rowsDeleted:
            executed && operation === "DELETE" ? before.rows - after.rows : 0,
          executedStatement,
          before,
          after,
          productionExecuted: false as const
        };
      } finally {
        await client.close();
      }
    }
  );
}

async function snapshot(
  client: Awaited<ReturnType<LocalEngine["open"]>>,
  table: string
): Promise<ShadowMigrationSnapshot> {
  const rows = await countRows(
    client,
    `gozzle_slice.${quoteIdentifier(table)}`
  );
  const dedup = await verifyDedup(client, {
    table: `gozzle_slice.${table}`,
    defaultDatabase: "gozzle_slice"
  });
  return {
    rows,
    duplicateGroups: dedup.duplicateGroups,
    duplicateRows: dedup.duplicateRows,
    maxCopies: dedup.maxCopies
  };
}

interface CountRow {
  count: string | number;
}

async function countRows(
  client: Awaited<ReturnType<LocalEngine["open"]>>,
  table: string
): Promise<number> {
  const [row] = await client.queryJson<CountRow>(
    `SELECT count() AS count FROM ${table}`
  );
  return toNumber(row?.count ?? 0);
}

async function countMatching(
  client: Awaited<ReturnType<LocalEngine["open"]>>,
  table: string,
  predicate: string
): Promise<number> {
  const [row] = await client.queryJson<CountRow>(
    `SELECT count() AS count FROM ${table} WHERE (${predicate})`
  );
  return toNumber(row?.count ?? 0);
}
