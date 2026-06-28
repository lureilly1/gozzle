import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { ClickHouseHttpMetadataClient } from "../../src/clickhouse/client.js";
import { dryRunMigration } from "../../src/clickhouse/migration.js";
import type { ClickHouseConnectionConfig } from "../../src/config/clickhouse.js";
import { DEFAULT_GUARDRAILS } from "../../src/config/guardrails.js";

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
const database = "gozzle_migration_integration";
const table = `${database}.migration_test`;

const config: ClickHouseConnectionConfig = {
  url,
  username,
  password,
  database
};

let admin: ClickHouseClient;

before(async () => {
  if (noServer) return;

  admin = createClient({ url, username, password });
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  await admin.command({ query: `DROP TABLE IF EXISTS ${table}` });
  await admin.command({
    query: `CREATE TABLE ${table}
      (
        id UInt64,
        raw String,
        status String
      )
      ENGINE = MergeTree
      ORDER BY id`
  });
  await admin.command({
    query: `INSERT INTO ${table} VALUES
      (1, '123', 'new'),
      (2, 'not-a-number', 'new')`
  });
});

after(async () => {
  if (noServer) return;

  await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  await admin.close();
});

test(
  "MODIFY COLUMN cast failure is proven read-only against current data",
  { skip: noServer && "no ClickHouse server configured" },
  async () => {
    const client = new ClickHouseHttpMetadataClient(config, DEFAULT_GUARDRAILS);
    try {
      const result = await dryRunMigration(client, {
        statement: `ALTER TABLE ${table} MODIFY COLUMN raw UInt64`,
        defaultDatabase: database
      });
      assert.equal(result.productionExecuted, false);
      assert.equal(result.parsed.classification, "part-rewriting");
      assert.equal(result.correctness[0]?.check, "cast-safety");
      assert.equal(result.correctness[0]?.status, "error");
      assert.match(result.correctness[0]?.message ?? "", /cannot be cast/i);
    } finally {
      await client.close();
    }
  }
);

test(
  "UPDATE assignment validates read-only and reports rewrite scope",
  { skip: noServer && "no ClickHouse server configured" },
  async () => {
    const client = new ClickHouseHttpMetadataClient(config, DEFAULT_GUARDRAILS);
    try {
      const result = await dryRunMigration(client, {
        statement: `ALTER TABLE ${table} UPDATE status = concat(status, '-done') WHERE id = 1`,
        defaultDatabase: database
      });
      assert.equal(result.productionExecuted, false);
      assert.equal(result.parsed.classification, "part-rewriting");
      assert.equal(result.rewrite.evidence, "predicate-part-scan");
      assert.equal(result.rewrite.matchingRows, 1);
      assert.deepEqual(
        result.correctness.map((finding) => finding.status),
        ["ok", "ok"]
      );
    } finally {
      await client.close();
    }
  }
);
