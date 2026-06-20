import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { query } from "chdb";

import { verifyDedup } from "../src/clickhouse/dedup.js";
import { ChdbLocalEngine } from "../src/local-engine/chdb.js";

test("chDB replays a ReplacingMergeTree slice and runs the dedup proof", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "gozzle-chdb-test-"));
  const dataPath = join(workspace, "source.parquet");

  try {
    query(
      `SELECT * FROM values('id String, version UInt64', ('a', 1), ('a', 2), ('b', 1)) INTO OUTFILE '${dataPath}' FORMAT Parquet`
    );
    const engine = new ChdbLocalEngine();
    const client = await engine.replay({
      workspacePath: workspace,
      createStatement: `CREATE DATABASE IF NOT EXISTS gozzle_slice;
CREATE TABLE gozzle_slice.events (
  id String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id`,
      dataPath,
      tableName: "gozzle_slice.events",
      insertColumns: ["id", "version"]
    });

    try {
      const result = await verifyDedup(client, {
        table: "gozzle_slice.events",
        defaultDatabase: "gozzle_slice"
      });
      assert.equal(result.eligible, true);
      assert.equal(result.duplicateGroups, 1);
      assert.equal(result.duplicateRows, 1);
      assert.equal(result.maxCopies, 2);
    } finally {
      await client.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
