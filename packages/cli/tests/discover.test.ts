import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { discoverWorkload } from "../src/clickhouse/query-log.js";
import {
  formatWorkload,
  parseDiscoverArgs
} from "../src/commands/discover.js";

class FakeClient implements ClickHouseMetadataClient {
  readonly queries: string[] = [];
  constructor(private readonly responses: Record<string, unknown[]>) {}
  async ping(): Promise<boolean> {
    return true;
  }
  async queryJson<T>(query: string): Promise<T[]> {
    this.queries.push(query);
    const key = Object.keys(this.responses).find((c) => query.includes(c));
    return (key ? this.responses[key] : []) as T[];
  }
  async close(): Promise<void> {}
}

test("discoverWorkload ranks queries and flags ReplacingMergeTree tables", async () => {
  const client = new FakeClient({
    "system.query_log": [
      {
        hash: "1",
        sample_query: "SELECT sum(amount) FROM analytics.events",
        runs: "8400",
        total_read_bytes: "12000000000",
        total_duration_ms: "90000",
        query_tables: ["analytics.events", "analytics.users"]
      }
    ],
    "system.tables": [
      { qualified: "analytics.events", engine: "ReplacingMergeTree" },
      { qualified: "analytics.users", engine: "MergeTree" }
    ]
  });

  const workload = await discoverWorkload(client, { defaultDatabase: "analytics" });
  assert.equal(workload.length, 1);
  assert.equal(workload[0].runs, 8400);
  assert.equal(workload[0].totalReadBytes, 12000000000);
  assert.deepEqual(workload[0].replacingTables, ["analytics.events"]);

  // The query_log aggregate must group + order as expected and not retain data.
  assert.match(client.queries[0], /FROM system\.query_log/);
  assert.match(client.queries[0], /GROUP BY normalized_query_hash/);
  assert.match(client.queries[0], /ORDER BY total_read_bytes DESC/);
  // Filters out the platform's internal system-only queries.
  assert.match(client.queries[0], /arrayExists/);
  assert.match(client.queries[0], /NOT IN \('system'/);
});

test("discoverWorkload skips the engine lookup when no tables are seen", async () => {
  const client = new FakeClient({
    "system.query_log": [
      {
        hash: "1",
        sample_query: "SELECT 1",
        runs: "5",
        total_read_bytes: "0",
        total_duration_ms: "1",
        query_tables: []
      }
    ]
  });
  const workload = await discoverWorkload(client, { defaultDatabase: "default" });
  assert.deepEqual(workload[0].replacingTables, []);
  assert.equal(
    client.queries.some((q) => q.includes("FROM system.tables")),
    false
  );
});

test("parseDiscoverArgs parses --since, --limit, --json and rejects junk", () => {
  assert.deepEqual(parseDiscoverArgs(["--since", "30d", "--limit", "5", "--json"]).options, {
    sinceDays: 30,
    limit: 5,
    json: true
  });
  assert.equal(parseDiscoverArgs(["--since", "7"]).options.sinceDays, 7);
  assert.match(parseDiscoverArgs(["--since", "soon"]).error ?? "", /--since/);
  assert.match(parseDiscoverArgs(["--limit", "0"]).error ?? "", /--limit/);
  assert.match(parseDiscoverArgs(["whoops"]).error ?? "", /Unknown argument/);
});

test("formatWorkload marks ReplacingMergeTree tables and summarizes", () => {
  const out = formatWorkload(
    [
      {
        hash: "1",
        sampleQuery: "SELECT sum(amount) FROM analytics.events",
        runs: 8400,
        totalReadBytes: 12000000000,
        totalDurationMs: 90000,
        tables: ["analytics.events", "analytics.users"],
        replacingTables: ["analytics.events"]
      }
    ],
    7
  );
  assert.match(out, /analytics\.events \[ReplacingMergeTree\]/);
  assert.match(out, /11\.2 GiB read · 8,400 run/);
  assert.match(out, /1 of 1 read ReplacingMergeTree tables/);
});

test("formatWorkload handles an empty workload", () => {
  assert.match(formatWorkload([], 7), /No SELECTs found/);
});
