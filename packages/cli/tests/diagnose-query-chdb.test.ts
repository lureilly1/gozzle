import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { query } from "chdb";

import { diagnoseQuery } from "../src/clickhouse/query-diagnosis.js";
import { ChdbLocalEngine } from "../src/local-engine/chdb.js";

test("chDB proves full scans and primary-key pruning without running the query", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "gozzle-diagnose-chdb-"));
  const dataPath = join(workspace, "source.parquet");

  try {
    query(`
      SELECT
        number % 10 AS tenant,
        number AS id,
        toDate('2026-01-01') + number % 60 AS day,
        if(number % 2 = 0, 'ok', 'failed') AS status,
        number AS version
      FROM numbers(20000)
      INTO OUTFILE '${dataPath}' FORMAT Parquet
    `);
    const client = await new ChdbLocalEngine().replay({
      workspacePath: workspace,
      createStatement: `CREATE DATABASE IF NOT EXISTS gozzle_slice;
CREATE TABLE gozzle_slice.events (
  tenant UInt64,
  id UInt64,
  day Date,
  status String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (tenant, id)`,
      dataPath,
      tableName: "gozzle_slice.events",
      insertColumns: ["tenant", "id", "day", "status", "version"]
    });

    try {
      const fullScan = await diagnoseQuery(
        client,
        "SELECT count() FROM gozzle_slice.events WHERE lower(status) = 'failed'"
      );
      assert.ok(fullScan.findings.some((item) => item.code === "full-scan"));
      assert.ok(
        fullScan.findings.some(
          (item) => item.code === "missing-primary-key-pruning"
        )
      );

      const pruned = await diagnoseQuery(
        client,
        "SELECT count() FROM gozzle_slice.events WHERE tenant = 3 AND id = 43"
      );
      assert.equal(
        pruned.findings.some((item) => item.code === "full-scan"),
        false
      );
      assert.equal(
        pruned.findings.some(
          (item) => item.code === "missing-primary-key-pruning"
        ),
        false
      );

      const finalQuery = await diagnoseQuery(
        client,
        "SELECT count() FROM gozzle_slice.events FINAL WHERE tenant = 3"
      );
      assert.equal(
        finalQuery.findings.find((item) => item.code === "final-cost")
          ?.confidence,
        "advisory"
      );
      assert.equal(finalQuery.originalQueryExecuted, false);
    } finally {
      await client.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
