import assert from "node:assert/strict";
import test from "node:test";

import { parseMigrationStatement } from "../src/clickhouse/migration-parser.js";

test("classifies ADD COLUMN as metadata-only", () => {
  const parsed = parseMigrationStatement(
    "ALTER TABLE analytics.events ADD COLUMN country LowCardinality(String)"
  );
  assert.deepEqual(parsed.table, { database: "analytics", table: "events" });
  assert.equal(parsed.classification, "metadata-only");
  assert.equal(parsed.rewriteScope, "none");
});

test("classifies predicate UPDATE and preserves the WHERE expression", () => {
  const parsed = parseMigrationStatement(`
    ALTER TABLE events
    UPDATE status = if(status = 'new,unread', 'new', status), version = version + 1
    WHERE tenant_id = 42 AND status IN ('new', 'new,unread')
  `);
  assert.equal(parsed.classification, "part-rewriting");
  assert.equal(parsed.rewriteScope, "predicate");
  assert.equal(
    parsed.predicate,
    "tenant_id = 42 AND status IN ('new', 'new,unread')"
  );
});

test("recognizes mutation keywords across line breaks", () => {
  const parsed = parseMigrationStatement(
    "ALTER TABLE events UPDATE\nstatus = 'done' WHERE(id = 42)"
  );
  assert.equal(parsed.classification, "part-rewriting");
  assert.equal(parsed.predicate, "(id = 42)");
});

test("removes mutation SETTINGS from the estimated predicate", () => {
  const parsed = parseMigrationStatement(
    "ALTER TABLE events DELETE WHERE id = 42 SETTINGS mutations_sync = 1"
  );
  assert.equal(parsed.predicate, "id = 42");
});

test("classifies materialized column operations conservatively", () => {
  const add = parseMigrationStatement(
    "ALTER TABLE events ADD COLUMN day Date MATERIALIZED toDate(timestamp)"
  );
  const populate = parseMigrationStatement(
    "ALTER TABLE events MATERIALIZE COLUMN day"
  );
  assert.equal(add.classification, "risky-materialized-column");
  assert.equal(add.rewriteScope, "none");
  assert.equal(populate.classification, "risky-materialized-column");
  assert.equal(populate.rewriteScope, "all");
});

test("refuses compound and unknown ALTER operations", () => {
  const compound = parseMigrationStatement(
    "ALTER TABLE events ADD COLUMN a UInt8, ADD COLUMN b UInt8"
  );
  const partition = parseMigrationStatement(
    "ALTER TABLE events DROP PARTITION '202601'"
  );
  assert.equal(compound.classification, "unsupported");
  assert.match(compound.reason, /Compound ALTER/);
  assert.equal(partition.classification, "unsupported");
});

test("refuses query-shaping clauses in mutation predicates", () => {
  const parsed = parseMigrationStatement(
    "ALTER TABLE events DELETE WHERE id = 42 FORMAT JSONEachRow"
  );
  assert.equal(parsed.classification, "unsupported");
  assert.match(parsed.reason, /top-level FORMAT/);
});

test("rejects comments and multiple statements", () => {
  assert.throws(
    () => parseMigrationStatement("ALTER TABLE events ADD COLUMN x UInt8; SELECT 1"),
    /exactly one statement/
  );
  assert.throws(
    () => parseMigrationStatement("ALTER TABLE events -- comment\nADD COLUMN x UInt8"),
    /comments are not accepted/
  );
});
