import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import type { DiagnoseQueryResult } from "../src/clickhouse/query-diagnosis.js";
import type { GozzleProjectConfig } from "../src/config/project.js";
import {
  aggregateExitCode,
  checkReadPaths,
  verifyFiles
} from "../src/commands/verify.js";

// Responds to EXPLAIN, inspect_table metadata, and the dedup proof queries.
function client(duplicateRows: string): ClickHouseMetadataClient {
  const responses: Record<string, unknown[]> = {
    EXPLAIN: [
      { explain: "ReadFromMergeTree (analytics.events)" },
      { explain: "Indexes:" },
      { explain: "  PrimaryKey" },
      { explain: "    Condition: (event_id in [1, 1])" },
      { explain: "    Parts: 1/4" },
      { explain: "    Granules: 2/20" }
    ],
    "SHOW CREATE TABLE": [
      {
        statement:
          "CREATE TABLE analytics.events (event_id String, version UInt64) ENGINE = ReplacingMergeTree(version) ORDER BY event_id"
      }
    ],
    "FROM system.tables": [
      {
        engine: "ReplacingMergeTree",
        engine_full: "ReplacingMergeTree(version)",
        sorting_key: "event_id",
        primary_key: "event_id",
        partition_key: "",
        total_rows: "100",
        total_bytes: "1000"
      }
    ],
    "FROM system.columns": [],
    "FROM system.parts": [
      { active_parts: "3", rows: "100", bytes_on_disk: "1000", partitions: "1" }
    ],
    duplicate_rows: [
      { duplicate_groups: "1", duplicate_rows: duplicateRows, max_copies: "3" }
    ],
    "AS _copies": [{ _partition_id: "all", event_id: "e1", _copies: "3" }]
  };
  return {
    ping: async () => true,
    queryJson: async <T>(query: string): Promise<T[]> => {
      const key = Object.keys(responses).find((c) => query.includes(c));
      return (key ? responses[key] : []) as T[];
    },
    close: async () => {}
  };
}

const config: GozzleProjectConfig = {
  queries: [],
  migrations: [],
  assumptions: { events: { uniqueBy: ["event_id"] } } // matches by bare name
};

function diagnosis(hasFinal = false): DiagnoseQueryResult {
  return {
    query: {
      query: "SELECT * FROM analytics.events",
      hasFinal,
      joinCount: 0,
      hasCrossJoin: false,
      hasFunctionWrappedPredicate: false,
      hasLeadingWildcard: false,
      selectsAllColumns: true
    },
    explain: { lines: [], tables: [{ table: "analytics.events", indexes: [] }] },
    tableSchemas: [],
    findings: [],
    originalQueryExecuted: false
  };
}

const NO_AUDIT = {} as NodeJS.ProcessEnv;

test("read-path proof flags a query that trusts a violated uniqueness assumption", async () => {
  const outcomes = await checkReadPaths(
    client("3"),
    diagnosis(),
    config,
    "default",
    NO_AUDIT
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "violated");
  assert.equal(outcomes[0].duplicateRows, 3);
  assert.match(outcomes[0].message, /can overcount/);
});

test("read-path proof is clean when current data has no duplicates", async () => {
  const outcomes = await checkReadPaths(
    client("0"),
    diagnosis(),
    config,
    "default",
    NO_AUDIT
  );
  assert.equal(outcomes[0].status, "clean");
});

test("read-path proof is skipped when the query already uses FINAL", async () => {
  const outcomes = await checkReadPaths(
    client("3"),
    diagnosis(true),
    config,
    "default",
    NO_AUDIT
  );
  assert.deepEqual(outcomes, []);
});

test("read-path proof does nothing without a gozzle.yaml", async () => {
  const outcomes = await checkReadPaths(
    client("3"),
    diagnosis(),
    undefined,
    "default",
    NO_AUDIT
  );
  assert.deepEqual(outcomes, []);
});

test("verifyFiles fails a query file on a proven read-path violation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gozzle-readpath-"));
  try {
    const file = join(dir, "revenue.sql");
    await writeFile(file, "SELECT * FROM analytics.events", "utf8");
    const outcomes = await verifyFiles(
      client("3"),
      [file],
      "default",
      { strict: false, json: false, changed: false },
      NO_AUDIT,
      config
    );
    assert.equal(outcomes[0].failing, true);
    assert.match(outcomes[0].text, /Read-path proof:/);
    assert.match(outcomes[0].text, /can overcount/);
    assert.equal(aggregateExitCode(outcomes), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
