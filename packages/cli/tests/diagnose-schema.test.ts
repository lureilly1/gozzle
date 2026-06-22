import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { diagnoseQuery } from "../src/clickhouse/query-diagnosis.js";
import { formatQueryDiagnosis } from "../src/tools/diagnose-query.js";

const FULL_SCAN = [
  "ReadFromMergeTree (analytics.events)",
  "Indexes:",
  "  PrimaryKey",
  "    Condition: true",
  "    Parts: 4/4",
  "    Granules: 20/20"
];

// Responds to EXPLAIN with a full-scan plan and to inspect_table's metadata
// queries with a table that has a real ORDER BY / PARTITION BY.
class SchemaAwareClient implements ClickHouseMetadataClient {
  async ping(): Promise<boolean> {
    return true;
  }
  async queryJson<T>(query: string): Promise<T[]> {
    if (query.includes("EXPLAIN")) {
      return FULL_SCAN.map((explain) => ({ explain })) as T[];
    }
    if (query.includes("SHOW CREATE TABLE")) {
      return [{ statement: "CREATE TABLE analytics.events (...)" }] as T[];
    }
    if (query.includes("FROM system.tables")) {
      return [
        {
          engine: "MergeTree",
          engine_full: "MergeTree",
          sorting_key: "user_id, event_id",
          primary_key: "user_id",
          partition_key: "toYYYYMM(ts)",
          total_rows: "1000",
          total_bytes: "100000"
        }
      ] as T[];
    }
    if (query.includes("FROM system.parts")) {
      return [
        { active_parts: "4", rows: "1000", bytes_on_disk: "100000", partitions: "2" }
      ] as T[];
    }
    return [];
  }
  async close(): Promise<void> {}
}

test("diagnoseQuery attaches table ORDER BY / PARTITION BY and makes the fix concrete", async () => {
  const result = await diagnoseQuery(
    new SchemaAwareClient(),
    "SELECT * FROM analytics.events",
    "default"
  );

  const schema = result.tableSchemas.find((s) => s.table === "analytics.events");
  assert.equal(schema?.orderBy, "user_id, event_id");
  assert.equal(schema?.partitionBy, "toYYYYMM(ts)");

  const fullScan = result.findings.find((f) => f.code === "full-scan");
  assert.ok(fullScan, "expected a full-scan finding");
  assert.match(fullScan!.recommendation, /PARTITION BY is \(toYYYYMM\(ts\)\)/);
  assert.match(fullScan!.recommendation, /ORDER BY is \(user_id, event_id\)/);

  const text = formatQueryDiagnosis(result);
  assert.match(text, /Status: FAIL/);
  assert.match(text, /ORDER BY: user_id, event_id/);
  assert.match(text, /PARTITION BY: toYYYYMM\(ts\)/);
});

test("diagnoseQuery degrades gracefully when a table cannot be inspected", async () => {
  // A client that only answers EXPLAIN (inspect queries return nothing) must
  // still produce findings, just without schema hints.
  const explainOnly: ClickHouseMetadataClient = {
    ping: async () => true,
    queryJson: async <T>(q: string): Promise<T[]> =>
      (q.includes("EXPLAIN") ? FULL_SCAN.map((explain) => ({ explain })) : []) as T[],
    close: async () => {}
  };
  const result = await diagnoseQuery(explainOnly, "SELECT * FROM analytics.events", "default");
  assert.ok(result.findings.some((f) => f.code === "full-scan"));
  assert.equal(result.tableSchemas[0].orderBy, undefined);
});
