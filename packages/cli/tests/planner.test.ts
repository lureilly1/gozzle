import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { verifyArtifact } from "../src/planner/planner.js";

class PlannerFakeClient implements ClickHouseMetadataClient {
  readonly queries: string[] = [];

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    this.queries.push(query);
    if (query.includes("DESCRIBE")) {
      return [{ name: "a", type: "UInt64" }] as T[];
    }
    if (query.includes("countIf")) {
      return [{ left_only: "0", right_only: "0" }] as T[];
    }
    if (query.includes("EXPLAIN")) {
      return explainRows as T[];
    }
    if (query.includes("SHOW CREATE TABLE")) {
      return [{ statement: createStatement }] as T[];
    }
    if (query.includes("FROM system.tables")) {
      return [tableRow] as T[];
    }
    if (query.includes("FROM system.columns")) {
      return columns as T[];
    }
    if (query.includes("FROM system.parts")) {
      return [
        {
          active_parts: "1",
          rows: "10",
          bytes_on_disk: "100",
          partitions: "1"
        }
      ] as T[];
    }
    return [];
  }

  async close(): Promise<void> {}
}

const explainRows = [
  { explain: "ReadFromMergeTree (analytics.events)" },
  { explain: "Indexes:" },
  { explain: "  PrimaryKey" },
  { explain: "    Condition: (id in [1, 1])" },
  { explain: "    Parts: 1/1" },
  { explain: "    Granules: 1/10" }
];

const createStatement = `CREATE TABLE analytics.events
(
  id UInt64
)
ENGINE = MergeTree
ORDER BY id`;

const tableRow = {
  engine: "MergeTree",
  engine_full: "MergeTree",
  sorting_key: "id",
  primary_key: "id",
  partition_key: "",
  total_rows: "10",
  total_bytes: "100"
};

const columns = [
  {
    name: "id",
    type: "UInt64",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  }
];

test("verifyArtifact dispatches a query pair to equivalence", async () => {
  const run = await verifyArtifact(
    new PlannerFakeClient(),
    { source: "query_pair", left: "SELECT a FROM t", right: "SELECT a FROM t" },
    { defaultDatabase: "default", source: "cli" }
  );
  assert.equal(run.artifact.type, "query_pair");
  assert.equal(run.verdict, "pass");
  assert.deepEqual(run.plan.executedChecks, ["query_equivalence"]);
});

test("verifyArtifact dispatches a query to diagnosis", async () => {
  const run = await verifyArtifact(
    new PlannerFakeClient(),
    { source: "content", content: "SELECT count() FROM analytics.events" },
    { defaultDatabase: "default", source: "cli" }
  );
  assert.equal(run.artifact.type, "query");
  assert.equal(run.productionExecuted, false);
  assert.deepEqual(run.plan.executedChecks, ["query_diagnosis"]);
});

test("verifyArtifact dispatches a migration to dry-run analysis", async () => {
  const run = await verifyArtifact(
    new PlannerFakeClient(),
    {
      source: "content",
      content: "ALTER TABLE analytics.events ADD COLUMN source String"
    },
    { defaultDatabase: "default", source: "cli" }
  );
  assert.equal(run.artifact.type, "migration");
  assert.equal(run.verdict, "pass");
  assert.deepEqual(run.plan.executedChecks, [
    "migration_blast_radius",
    "migration_correctness"
  ]);
});

test("verifyArtifact returns indeterminate for unsupported artifacts", async () => {
  const run = await verifyArtifact(
    new PlannerFakeClient(),
    { source: "content", content: "INSERT INTO events VALUES (1)" },
    { defaultDatabase: "default", source: "cli" }
  );
  assert.equal(run.artifact.type, "unknown");
  assert.equal(run.verdict, "indeterminate");
  assert.equal(run.limits[0]?.type, "unsupported_syntax");
});

test("verifyArtifact supports plan-only mode without querying ClickHouse", async () => {
  const client = new PlannerFakeClient();
  const run = await verifyArtifact(
    client,
    { source: "content", content: "SELECT count() FROM analytics.events" },
    { defaultDatabase: "default", source: "cli", planOnly: true }
  );
  assert.equal(run.verdict, "indeterminate");
  assert.deepEqual(run.plan.executedChecks, ["query_diagnosis"]);
  assert.equal(client.queries.length, 0);
});
