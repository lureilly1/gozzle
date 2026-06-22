import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { verifyDedup } from "../src/clickhouse/dedup.js";
import { formatDedupResult } from "../src/tools/verify-dedup.js";

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

const replacingCreate = `CREATE TABLE analytics.events
(
    \`id\` String,
    \`version\` UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id`;

const partitionedCreate = `CREATE TABLE analytics.events
(
    \`id\` String,
    \`p\` UInt8,
    \`version\` UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY p
ORDER BY id`;

function replacingTableResponses(
  extra: Record<string, unknown[]>,
  createStatement: string = replacingCreate,
  partitionKey = ""
): Record<string, unknown[]> {
  return {
    "SHOW CREATE TABLE": [{ statement: createStatement }],
    "FROM system.tables": [
      {
        engine: "ReplacingMergeTree",
        engine_full: "ReplacingMergeTree(version)",
        sorting_key: "id",
        primary_key: "id",
        partition_key: partitionKey,
        total_rows: "100",
        total_bytes: "1000"
      }
    ],
    "FROM system.columns": [],
    "FROM system.parts": [
      { active_parts: "3", rows: "100", bytes_on_disk: "1000", partitions: "1" }
    ],
    ...extra
  };
}

test("verify_dedup reports duplicates with evidence", async () => {
  const client = new FakeMetadataClient(
    replacingTableResponses({
      duplicate_rows: [
        { duplicate_groups: "2", duplicate_rows: "3", max_copies: "3" }
      ],
      final_dups: [{ final_dups: "3" }],
      "AS _copies": [
        { _partition_id: "all", id: "a", _copies: "3" },
        { _partition_id: "all", id: "b", _copies: "2" }
      ]
    })
  );

  const result = await verifyDedup(client, {
    table: "analytics.events",
    defaultDatabase: "default"
  });

  assert.equal(result.eligible, true);
  assert.equal(result.duplicateGroups, 2);
  assert.equal(result.duplicateRows, 3);
  assert.equal(result.finalCollapsibleRows, 3);
  assert.equal(result.maxCopies, 3);
  assert.equal(result.sample.length, 2);
  assert.deepEqual(result.sample[0].key, { id: "a" });

  const output = formatDedupResult(result);
  assert.match(output, /3 duplicate row\(s\) across 2 sorting-key group\(s\)/);
  assert.match(output, /id=a -> 3 copies/);
});

test("verify_dedup reports a clean table", async () => {
  const client = new FakeMetadataClient(
    replacingTableResponses({
      duplicate_rows: [
        { duplicate_groups: "0", duplicate_rows: "0", max_copies: "0" }
      ],
      final_dups: [{ final_dups: "0" }]
    })
  );

  const result = await verifyDedup(client, {
    table: "analytics.events",
    defaultDatabase: "default"
  });

  assert.equal(result.eligible, true);
  assert.equal(result.duplicateRows, 0);
  assert.equal(result.finalCollapsibleRows, 0);
  assert.match(formatDedupResult(result), /No duplicates by sorting key/);
});

test("verify_dedup distinguishes merge vs FINAL on partitioned tables", async () => {
  // Per-partition merges collapse 1 row; SELECT FINAL collapses 3 globally.
  const client = new FakeMetadataClient(
    replacingTableResponses(
      {
        duplicate_rows: [
          { duplicate_groups: "1", duplicate_rows: "1", max_copies: "2" }
        ],
        final_dups: [{ final_dups: "3" }],
        "AS _copies": [{ _partition_id: "1", id: "1", _copies: "2" }]
      },
      partitionedCreate,
      "p"
    )
  );

  const result = await verifyDedup(client, {
    table: "analytics.events",
    defaultDatabase: "default"
  });

  assert.equal(result.isPartitioned, true);
  assert.equal(result.duplicateRows, 1);
  assert.equal(result.finalCollapsibleRows, 3);

  const output = formatDedupResult(result);
  assert.match(output, /Background merges collapse 1 row\(s\)/);
  assert.match(output, /SELECT \.\.\. FINAL collapses 3 row\(s\)/);
  assert.match(output, /cross-partition duplicates that background merges never remove/);
});

class TrackingFakeMetadataClient implements ClickHouseMetadataClient {
  readonly queries: string[] = [];

  constructor(private readonly responses: Record<string, unknown[]>) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    this.queries.push(query);
    const key = Object.keys(this.responses).find((candidate) =>
      query.includes(candidate)
    );
    return (key ? this.responses[key] : []) as T[];
  }

  async close(): Promise<void> {}
}

test("verify_dedup skips the global FINAL scan on an unpartitioned table", async () => {
  const client = new TrackingFakeMetadataClient(
    replacingTableResponses({
      duplicate_rows: [
        { duplicate_groups: "1", duplicate_rows: "2", max_copies: "3" }
      ],
      "AS _copies": [{ _partition_id: "all", id: "a", _copies: "3" }]
    })
  );

  const result = await verifyDedup(client, {
    table: "analytics.events",
    defaultDatabase: "default"
  });

  // Single scope: FINAL collapse equals the per-partition floor without the
  // expensive global uniqExact scan.
  assert.equal(result.finalCollapsibleRows, result.duplicateRows);
  assert.equal(result.duplicateRows, 2);
  assert.ok(
    !client.queries.some((query) => query.includes("count() - uniqExact")),
    "no global FINAL scan should run for an unpartitioned table"
  );
});

test("verify_dedup skips the global FINAL scan when a partition is scoped", async () => {
  const client = new TrackingFakeMetadataClient(
    replacingTableResponses(
      {
        duplicate_rows: [
          { duplicate_groups: "1", duplicate_rows: "1", max_copies: "2" }
        ],
        "AS _copies": [{ _partition_id: "1", id: "1", _copies: "2" }]
      },
      partitionedCreate,
      "p"
    )
  );

  const result = await verifyDedup(client, {
    table: "analytics.events",
    defaultDatabase: "default",
    partitionId: "1"
  });

  assert.equal(result.finalCollapsibleRows, result.duplicateRows);
  assert.ok(
    !client.queries.some((query) => query.includes("count() - uniqExact")),
    "no global FINAL scan should run when a partition is scoped"
  );
  assert.ok(
    client.queries.some((query) => query.includes("_partition_id = '1'")),
    "the proof should be scoped to the requested partition"
  );
});

test("verify_dedup refuses an oversized unscoped table and lists partitions", async () => {
  const client = new TrackingFakeMetadataClient({
    "SHOW CREATE TABLE": [{ statement: partitionedCreate }],
    "FROM system.tables": [
      {
        engine: "ReplacingMergeTree",
        engine_full: "ReplacingMergeTree(version)",
        sorting_key: "id",
        primary_key: "id",
        partition_key: "p",
        total_rows: "5000",
        total_bytes: "5000"
      }
    ],
    "FROM system.columns": [],
    active_parts: [
      { active_parts: "3", rows: "5000", bytes_on_disk: "5000", partitions: "2" }
    ],
    "rows DESC": [
      { partition_id: "202401", rows: "3000", bytes: "3000" },
      { partition_id: "202402", rows: "2000", bytes: "2000" }
    ]
  });

  const result = await verifyDedup(client, {
    table: "analytics.events",
    defaultDatabase: "default",
    maxScanRows: 1000
  });

  assert.equal(result.scanSkipped, true);
  assert.equal(result.largestPartitions?.length, 2);
  assert.equal(result.largestPartitions?.[0].partitionId, "202401");
  assert.ok(
    !client.queries.some((query) => query.includes("GROUP BY _partition_id")),
    "no full-table proof scan should run when the guard refuses"
  );

  const output = formatDedupResult(result);
  assert.match(output, /too large to prove in one pass/);
  assert.match(output, /202401 \(3000 rows, 3000 bytes\)/);
});

test("verify_dedup is not eligible for non-replacing engines", async () => {
  const client = new FakeMetadataClient({
    "SHOW CREATE TABLE": [
      { statement: "CREATE TABLE t (id String) ENGINE = MergeTree ORDER BY id" }
    ],
    "FROM system.tables": [
      {
        engine: "MergeTree",
        engine_full: "MergeTree",
        sorting_key: "id",
        primary_key: "id",
        partition_key: "",
        total_rows: "10",
        total_bytes: "100"
      }
    ],
    "FROM system.columns": [],
    "FROM system.parts": []
  });

  const result = await verifyDedup(client, {
    table: "default.t",
    defaultDatabase: "default"
  });

  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /not a ReplacingMergeTree/);
  assert.match(formatDedupResult(result), /not eligible/);
});
