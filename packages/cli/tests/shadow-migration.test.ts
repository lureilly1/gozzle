import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { query } from "chdb";

import type {
  ClickHouseExportClient,
  ExportLimits
} from "../src/clickhouse/client.js";
import { ChdbLocalEngine } from "../src/local-engine/chdb.js";
import {
  shadowExecuteMigration,
  ShadowMigrationUnsupportedError
} from "../src/local-engine/shadow-migration.js";

const createStatement = `CREATE TABLE analytics.events
(
  id String,
  status String,
  version UInt64,
  created_at DateTime
)
ENGINE = SharedReplacingMergeTree('/path', '{replica}', version)
PARTITION BY toYYYYMM(created_at)
ORDER BY id`;

const tableRow = {
  engine: "SharedReplacingMergeTree",
  engine_full: "SharedReplacingMergeTree('/path', '{replica}', version)",
  sorting_key: "id",
  primary_key: "id",
  partition_key: "toYYYYMM(created_at)",
  total_rows: "3",
  total_bytes: "256"
};

const columns = [
  {
    name: "id",
    type: "String",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  },
  {
    name: "status",
    type: "String",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  },
  {
    name: "version",
    type: "UInt64",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  },
  {
    name: "created_at",
    type: "DateTime",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  }
];

/**
 * A fake production source whose exportParquet copies a pre-built, real Parquet
 * file so the ChdbLocalEngine can actually replay it. Everything else answers
 * the inspection/partition/dedup metadata queries createLocalSlice runs.
 */
class FakeSource implements ClickHouseExportClient {
  constructor(private readonly fixtureParquet: string) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(q: string): Promise<T[]> {
    if (q.includes("SHOW CREATE TABLE"))
      return [{ statement: createStatement }] as T[];
    if (q.includes("FROM system.tables")) return [tableRow] as T[];
    if (q.includes("FROM system.columns")) return columns as T[];
    if (q.includes("GROUP BY partition_id")) {
      return [
        { partition_id: "202606", rows: "3", bytes_on_disk: "256" }
      ] as T[];
    }
    if (q.includes("FROM system.parts")) {
      return [
        { active_parts: "1", rows: "3", bytes_on_disk: "256", partitions: "1" }
      ] as T[];
    }
    // verifyDedup on the source: no duplicates (distinct ids).
    if (q.includes("AS _copies")) return [] as T[];
    if (q.includes("duplicate_rows")) {
      return [
        { duplicate_groups: "0", duplicate_rows: "0", max_copies: "0" }
      ] as T[];
    }
    return [] as T[];
  }

  async exportParquet(
    _q: string,
    destination: string,
    _limits: ExportLimits
  ): Promise<{ bytesWritten: number }> {
    await copyFile(this.fixtureParquet, destination);
    return { bytesWritten: 256 };
  }

  async close(): Promise<void> {}
}

async function withHarness(
  run: (
    source: FakeSource,
    root: string,
    ephemeralRoot: string
  ) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gozzle-shadow-"));
  const fixture = join(root, "fixture.parquet");
  // Real Parquet with three distinct ids so the RMT slice has no duplicates.
  query(
    `SELECT id, status, version, created_at FROM values(
       'id String, status String, version UInt64, created_at DateTime',
       ('a', 'ok', 1, toDateTime('2026-06-01 00:00:00')),
       ('b', 'ok', 1, toDateTime('2026-06-02 00:00:00')),
       ('c', 'ok', 1, toDateTime('2026-06-03 00:00:00'))
     ) INTO OUTFILE '${fixture}' FORMAT Parquet`
  );
  try {
    await run(new FakeSource(fixture), join(root, "slices"), join(root, "tmp"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const localSliceConfig = (root: string) => ({
  rootDirectory: root,
  maxRows: 1000,
  maxBytes: 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
});

const ephemeralConfig = (root: string) => ({
  enabled: true,
  rootDirectory: root,
  persistOnFailure: false,
  cleanupAfterMinutes: 60
});

test("shadow execution runs a DELETE and reports the real physical effect", async () => {
  await withHarness(async (source, root, ephemeralRoot) => {
    const result = await shadowExecuteMigration(
      source,
      new ChdbLocalEngine(),
      {
        statement: "ALTER TABLE analytics.events DELETE WHERE id = 'a'",
        partitionId: "202606",
        defaultDatabase: "default"
      },
      localSliceConfig(root),
      ephemeralConfig(ephemeralRoot)
    );
    assert.equal(result.executed, true);
    assert.equal(result.operation, "DELETE");
    assert.equal(result.matchedRows, 1);
    assert.equal(result.before.rows, 3);
    assert.equal(result.after.rows, 2);
    assert.equal(result.rowsDeleted, 1);
    assert.equal(result.productionExecuted, false);
  });
});

test("shadow execution runs an UPDATE on a non-key column", async () => {
  await withHarness(async (source, root, ephemeralRoot) => {
    const result = await shadowExecuteMigration(
      source,
      new ChdbLocalEngine(),
      {
        statement:
          "ALTER TABLE analytics.events UPDATE status = 'failed' WHERE version < 5",
        partitionId: "202606",
        defaultDatabase: "default"
      },
      localSliceConfig(root),
      ephemeralConfig(ephemeralRoot)
    );
    assert.equal(result.executed, true);
    assert.equal(result.operation, "UPDATE");
    assert.equal(result.matchedRows, 3);
    assert.equal(result.after.rows, 3); // UPDATE never changes physical row count
  });
});

test("shadow execution reports ClickHouse rejecting an UPDATE to a key column", async () => {
  await withHarness(async (source, root, ephemeralRoot) => {
    const result = await shadowExecuteMigration(
      source,
      new ChdbLocalEngine(),
      {
        statement:
          "ALTER TABLE analytics.events UPDATE id = 'z' WHERE version < 5",
        partitionId: "202606",
        defaultDatabase: "default"
      },
      localSliceConfig(root),
      ephemeralConfig(ephemeralRoot)
    );
    assert.equal(result.executed, false);
    assert.match(result.executionError ?? "", /key column/i);
    assert.equal(result.after.rows, result.before.rows);
  });
});

test("shadow execution refuses non-predicate migrations", async () => {
  await withHarness(async (source, root, ephemeralRoot) => {
    await assert.rejects(
      shadowExecuteMigration(
        source,
        new ChdbLocalEngine(),
        {
          statement: "ALTER TABLE analytics.events ADD COLUMN note String",
          partitionId: "202606",
          defaultDatabase: "default"
        },
        localSliceConfig(root),
        ephemeralConfig(ephemeralRoot)
      ),
      ShadowMigrationUnsupportedError
    );
  });
});
