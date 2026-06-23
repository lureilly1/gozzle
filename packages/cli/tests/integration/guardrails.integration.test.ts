import assert from "node:assert/strict";
import test, { before, after } from "node:test";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { ClickHouseHttpMetadataClient } from "../../src/clickhouse/client.js";
import type { ClickHouseConnectionConfig } from "../../src/config/clickhouse.js";
import { DEFAULT_GUARDRAILS } from "../../src/config/guardrails.js";

// These tests prove protocol-level behavior chDB cannot exercise: that
// readonly=2 actually blocks writes over HTTP, that gozzle's guardrail
// settings are accepted *alongside* readonly=2, and that a read limit aborts
// an oversized scan. They require a real ClickHouse server. Start one with:
//
//   docker compose -f tests/integration/docker-compose.yml up -d
//
// and point GOZZLE_CLICKHOUSE_URL (or CLICKHOUSE_URL) at it. When no server is
// configured the suite skips rather than failing, so it stays out of the way
// of the default `npm test` run.
const url =
  process.env.GOZZLE_CLICKHOUSE_URL ?? process.env.CLICKHOUSE_URL ?? "";
const username =
  process.env.GOZZLE_CLICKHOUSE_USER ??
  process.env.CLICKHOUSE_USER ??
  "default";
const password =
  process.env.GOZZLE_CLICKHOUSE_PASSWORD ??
  process.env.CLICKHOUSE_PASSWORD ??
  "";

const noServer = url.trim() === "";
const database = "gozzle_integration";

const config: ClickHouseConnectionConfig = {
  url,
  username,
  password,
  database
};

// Admin client without gozzle's read-only enforcement, used only to seed
// fixtures. This is the privileged path gozzle never uses at runtime.
let admin: ClickHouseClient;

before(async () => {
  if (noServer) {
    return;
  }

  admin = createClient({ url, username, password });
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await admin.command({
    query: `CREATE TABLE IF NOT EXISTS ${database}.seed
      (id UInt64)
      ENGINE = MergeTree
      ORDER BY id`
  });
  await admin.command({
    query: `INSERT INTO ${database}.seed SELECT number FROM numbers(100000)`
  });
});

after(async () => {
  if (noServer) {
    return;
  }

  await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  await admin.close();
});

test(
  "readonly=2 is the effective session setting over HTTP",
  { skip: noServer && "no ClickHouse server configured" },
  async () => {
    const client = new ClickHouseHttpMetadataClient(config, DEFAULT_GUARDRAILS);
    try {
      // The load-bearing assertion: gozzle's guardrail settings are accepted
      // by the server *and* the session is genuinely pinned to readonly=2.
      const rows = await client.queryJson<{ value: string }>(
        "SELECT value FROM system.settings WHERE name = 'readonly'"
      );
      assert.equal(rows[0]?.value, "2");
    } finally {
      await client.close();
    }
  }
);

test(
  "readonly=2 rejects writes even with a write-capable account",
  { skip: noServer && "no ClickHouse server configured" },
  async () => {
    const client = new ClickHouseHttpMetadataClient(config, DEFAULT_GUARDRAILS);
    try {
      await assert.rejects(
        client.queryJson(`INSERT INTO ${database}.seed VALUES (1)`),
        /readonly|read-only|cannot|not allowed/i
      );
    } finally {
      await client.close();
    }
  }
);

test(
  "readonly=2 rejects DDL",
  { skip: noServer && "no ClickHouse server configured" },
  async () => {
    const client = new ClickHouseHttpMetadataClient(config, DEFAULT_GUARDRAILS);
    try {
      await assert.rejects(
        client.queryJson(`CREATE TABLE ${database}.should_not_exist (x UInt8)
          ENGINE = MergeTree ORDER BY x`),
        /readonly|read-only|cannot|not allowed/i
      );
    } finally {
      await client.close();
    }
  }
);

test(
  "max_rows_to_read aborts an oversized scan but allows a bounded read",
  { skip: noServer && "no ClickHouse server configured" },
  async () => {
    // The limit counts rows *scanned*, not matched, and MergeTree reads in
    // ~8192-row granules. The seed table has 100k rows, so a 50k limit sits
    // between a single-granule primary-key lookup and a full-table scan.
    // `sum()` is used over `count()` to avoid trivial-count metadata
    // optimization, which would read zero rows and never trip the limit.
    const client = new ClickHouseHttpMetadataClient(config, {
      ...DEFAULT_GUARDRAILS,
      maxResultRows: 0, // isolate the read limit from the result-row limit
      maxRowsToRead: 50000
    });
    try {
      // A primary-key-bounded scan reads one granule, under the limit, and
      // proves the read limit coexists with readonly=2 on the same request.
      const ok = await client.queryJson<{ s: string }>(
        `SELECT sum(id) AS s FROM ${database}.seed WHERE id < 500`
      );
      assert.ok(ok[0]?.s !== undefined);

      // A full-table scan must read more than the limit and is aborted.
      await assert.rejects(
        client.queryJson(`SELECT sum(id) FROM ${database}.seed`),
        /limit|exceed|too many|overflow/i
      );
    } finally {
      await client.close();
    }
  }
);
