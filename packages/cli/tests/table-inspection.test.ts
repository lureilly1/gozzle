import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import {
  formatTableIdentifier,
  parseTableIdentifier,
  resolveTableIdentifier
} from "../src/clickhouse/identifier.js";
import {
  extractClause,
  inspectTable
} from "../src/clickhouse/table-inspection.js";
import { formatTableInspection } from "../src/tools/inspect-table.js";

class FakeMetadataClient implements ClickHouseMetadataClient {
  constructor(private readonly responses: Record<string, unknown[]>) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    const key = Object.keys(this.responses).find((candidate) =>
      query.includes(candidate)
    );

    return (key ? this.responses[key] : []) as T[];
  }

  async close(): Promise<void> {}
}

const createStatement = `CREATE TABLE analytics.events
(
    \`tenant_id\` String,
    \`event_id\` String,
    \`version\` UInt64 CODEC(Delta, ZSTD),
    \`created_at\` DateTime
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, event_id)
PRIMARY KEY tenant_id
SETTINGS index_granularity = 8192`;

test("parses and formats table identifiers", () => {
  assert.deepEqual(parseTableIdentifier("events"), {
    database: undefined,
    table: "events"
  });
  assert.deepEqual(parseTableIdentifier("analytics.events"), {
    database: "analytics",
    table: "events"
  });
  assert.deepEqual(
    resolveTableIdentifier(parseTableIdentifier("events"), "default"),
    {
      database: "default",
      table: "events"
    }
  );
  assert.equal(
    formatTableIdentifier({ database: "analytics", table: "events" }),
    "`analytics`.`events`"
  );
  assert.throws(() => parseTableIdentifier("analytics.events.extra"));
  assert.throws(() => parseTableIdentifier("analytics.bad-table"));
});

test("extracts ClickHouse DDL clauses", () => {
  assert.equal(
    extractClause(createStatement, "ORDER BY"),
    "(tenant_id, event_id)"
  );
  assert.equal(
    extractClause(createStatement, "PARTITION BY"),
    "toYYYYMM(created_at)"
  );
});

test("inspects ReplacingMergeTree table layout", async () => {
  const client = new FakeMetadataClient({
    "SHOW CREATE TABLE": [{ statement: createStatement }],
    "FROM system.tables": [
      {
        engine: "ReplacingMergeTree",
        engine_full: "ReplacingMergeTree(version)",
        sorting_key: "tenant_id, event_id",
        primary_key: "tenant_id",
        partition_key: "toYYYYMM(created_at)",
        total_rows: "184203991",
        total_bytes: "28400000000"
      }
    ],
    "FROM system.columns": [
      {
        name: "tenant_id",
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
        codec_expression: "Delta, ZSTD"
      }
    ],
    "FROM system.parts": [
      {
        active_parts: "42",
        rows: "184203991",
        bytes_on_disk: "28400000000",
        partitions: "12"
      }
    ]
  });

  const inspection = await inspectTable(client, {
    table: "events",
    defaultDatabase: "analytics"
  });

  assert.equal(inspection.identifier.database, "analytics");
  assert.equal(inspection.engine, "ReplacingMergeTree");
  assert.equal(inspection.orderBy, "(tenant_id, event_id)");
  assert.equal(inspection.partitionBy, "toYYYYMM(created_at)");
  assert.equal(inspection.primaryKey, "tenant_id");
  assert.equal(inspection.totalRows, 184203991);
  assert.equal(inspection.parts.activeParts, 42);
  assert.equal(inspection.parts.partitions, 12);
  assert.equal(inspection.replacingMergeTree?.versionColumn, "version");
  assert.equal(inspection.eligibleChecks.verifyDedup, true);
  assert.match(inspection.warnings.join("\n"), /without FINAL/);
});

test("formats table inspection output", async () => {
  const client = new FakeMetadataClient({
    "SHOW CREATE TABLE": [{ statement: createStatement }],
    "FROM system.tables": [
      {
        engine: "ReplacingMergeTree",
        engine_full: "ReplacingMergeTree(version)",
        sorting_key: "tenant_id, event_id",
        primary_key: "tenant_id",
        partition_key: "toYYYYMM(created_at)",
        total_rows: 10,
        total_bytes: 200
      }
    ],
    "FROM system.columns": [],
    "FROM system.parts": [
      {
        active_parts: 2,
        rows: 10,
        bytes_on_disk: 200,
        partitions: 1
      }
    ]
  });

  const inspection = await inspectTable(client, {
    table: "analytics.events",
    defaultDatabase: "default"
  });
  const output = formatTableInspection(inspection);

  assert.match(output, /Table: analytics\.events/);
  assert.match(output, /Engine: ReplacingMergeTree\(version\)/);
  assert.match(output, /verify_dedup: yes/);
  assert.match(output, /create_local_slice: yes/);
});

test("marks Distributed tables as advisory for dedup", async () => {
  const client = new FakeMetadataClient({
    "SHOW CREATE TABLE": [
      {
        statement:
          "CREATE TABLE analytics.events_dist AS analytics.events ENGINE = Distributed(cluster, analytics, events)"
      }
    ],
    "FROM system.tables": [
      {
        engine: "Distributed",
        engine_full: "Distributed(cluster, analytics, events)",
        sorting_key: "",
        primary_key: "",
        partition_key: "",
        total_rows: 0,
        total_bytes: 0
      }
    ],
    "FROM system.columns": [],
    "FROM system.parts": []
  });

  const inspection = await inspectTable(client, {
    table: "analytics.events_dist",
    defaultDatabase: "default"
  });

  assert.equal(inspection.isDistributed, true);
  assert.equal(inspection.eligibleChecks.verifyDedup, false);
  assert.match(inspection.warnings.join("\n"), /Distributed table/);
});
