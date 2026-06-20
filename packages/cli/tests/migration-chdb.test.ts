import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { query } from "chdb";

import { dryRunMigration } from "../src/clickhouse/migration.js";
import { ChdbLocalEngine } from "../src/local-engine/chdb.js";

test("chDB executes the predicate-to-parts migration estimate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "gozzle-migration-chdb-"));
  const dataPath = join(workspace, "source.parquet");

  try {
    query(
      `SELECT * FROM values('id String, version UInt64', ('a', 1), ('a', 2), ('b', 1)) INTO OUTFILE '${dataPath}' FORMAT Parquet`
    );
    const client = await new ChdbLocalEngine().replay({
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
      const result = await dryRunMigration(client, {
        statement:
          "ALTER TABLE gozzle_slice.events UPDATE version = version + 1 WHERE id = 'a'",
        defaultDatabase: "gozzle_slice"
      });
      assert.equal(result.rewrite.evidence, "predicate-part-scan");
      assert.equal(result.rewrite.matchingRows, 2);
      assert.equal(result.rewrite.affectedParts, 1);
      assert.equal(result.rewrite.affectedPartRows, 3);
      assert.ok(result.rewrite.affectedBytes > 0);
    } finally {
      await client.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
