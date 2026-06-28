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
  assert.deepEqual(parsed.assignments, [
    {
      column: "status",
      expression: "if(status = 'new,unread', 'new', status)"
    },
    { column: "version", expression: "version + 1" }
  ]);
});

test("extracts plain MODIFY COLUMN target type", () => {
  const parsed = parseMigrationStatement(
    "ALTER TABLE events MODIFY COLUMN `status` LowCardinality(Nullable(String)) CODEC(ZSTD)"
  );
  assert.deepEqual(parsed.columnChange, {
    column: "status",
    type: "LowCardinality(Nullable(String))"
  });
});

test("extracts ADD/MODIFY column expressions for read-only validation", () => {
  const add = parseMigrationStatement(
    "ALTER TABLE events ADD COLUMN day Date DEFAULT toDate(timestamp)"
  );
  const modify = parseMigrationStatement(
    "ALTER TABLE events MODIFY COLUMN status String MATERIALIZED concat(prefix, '-', suffix) COMMENT 'derived'"
  );
  assert.deepEqual(add.columnExpression, {
    column: "day",
    type: "Date",
    kind: "DEFAULT",
    expression: "toDate(timestamp)"
  });
  assert.deepEqual(modify.columnExpression, {
    column: "status",
    type: "String",
    kind: "MATERIALIZED",
    expression: "concat(prefix, '-', suffix)"
  });
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

test("preserves a settings column in the mutation predicate", () => {
  const direct = parseMigrationStatement(
    "ALTER TABLE events UPDATE status = 'done' WHERE settings = 1"
  );
  const conjunction = parseMigrationStatement(
    "ALTER TABLE events DELETE WHERE tenant_id = 42 AND settings = 1"
  );
  assert.equal(direct.predicate, "settings = 1");
  assert.equal(conjunction.predicate, "tenant_id = 42 AND settings = 1");
});

test("refuses partition-scoped predicate mutations", () => {
  const remove = parseMigrationStatement(
    "ALTER TABLE events DELETE IN PARTITION '202601' WHERE tenant_id = 42"
  );
  const update = parseMigrationStatement(
    "ALTER TABLE events UPDATE status = 'done' IN PARTITION '202601' WHERE tenant_id = 42"
  );
  assert.equal(remove.classification, "unsupported");
  assert.equal(update.classification, "unsupported");
  assert.match(remove.reason, /does not yet preserve partition scope/);
});

test("refuses UPDATE mutations without parseable assignments", () => {
  const parsed = parseMigrationStatement(
    "ALTER TABLE events UPDATE WHERE tenant_id = 42"
  );
  assert.equal(parsed.classification, "unsupported");
  assert.match(parsed.reason, /no parseable assignments/);
});

test("refuses subqueries and external-access functions in predicates", () => {
  const subquery = parseMigrationStatement(
    "ALTER TABLE events DELETE WHERE id IN (SELECT id FROM other_events)"
  );
  const remote = parseMigrationStatement(
    "ALTER TABLE events DELETE WHERE id IN (SELECT id FROM url('http://169.254.169.254/latest', 'JSONEachRow', 'id UInt64'))"
  );
  const directExternal = parseMigrationStatement(
    "ALTER TABLE events DELETE WHERE url('http://example.com') = 1"
  );
  assert.equal(subquery.classification, "unsupported");
  assert.match(subquery.reason, /subqueries are not supported/);
  assert.equal(remote.classification, "unsupported");
  assert.equal(directExternal.classification, "unsupported");
  assert.match(directExternal.reason, /external-access function url/);
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
    () =>
      parseMigrationStatement(
        "ALTER TABLE events ADD COLUMN x UInt8; SELECT 1"
      ),
    /exactly one statement/
  );
  assert.throws(
    () =>
      parseMigrationStatement(
        "ALTER TABLE events -- comment\nADD COLUMN x UInt8"
      ),
    /comments are not accepted/
  );
});
