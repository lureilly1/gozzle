import assert from "node:assert/strict";
import test from "node:test";

import {
  detectStatementKind,
  stripSqlComments
} from "../src/clickhouse/statement.js";

test("stripSqlComments removes line and block comments", () => {
  const sql = `-- header comment
SELECT id /* inline */ FROM events
-- trailing note
WHERE id > 0`;
  const out = stripSqlComments(sql);
  assert.ok(!out.includes("header comment"));
  assert.ok(!out.includes("inline"));
  assert.ok(!out.includes("trailing note"));
  assert.match(out, /SELECT id\s+FROM events/);
  assert.match(out, /WHERE id > 0/);
});

test("stripSqlComments keeps comment markers inside literals", () => {
  assert.equal(
    stripSqlComments(`SELECT '-- not a comment' AS s`),
    `SELECT '-- not a comment' AS s`
  );
  assert.equal(
    stripSqlComments(`SELECT '/* still text */' AS s`),
    `SELECT '/* still text */' AS s`
  );
  assert.equal(
    stripSqlComments("SELECT `col -- name` FROM t"),
    "SELECT `col -- name` FROM t"
  );
});

test("stripSqlComments handles doubled quotes in literals", () => {
  assert.equal(
    stripSqlComments(`SELECT 'it''s -- fine' AS s`),
    `SELECT 'it''s -- fine' AS s`
  );
});

test("detectStatementKind classifies by leading keyword", () => {
  assert.equal(detectStatementKind("SELECT 1"), "query");
  assert.equal(detectStatementKind("  with x as (select 1) select * from x"), "query");
  assert.equal(detectStatementKind("ALTER TABLE t ADD COLUMN x UInt8"), "migration");
  assert.equal(detectStatementKind("INSERT INTO t VALUES (1)"), "unknown");
  assert.equal(detectStatementKind("DROP TABLE t"), "unknown");
});

test("comment-stripping then detection recovers the kind", () => {
  const sql = `-- what this does\nSELECT * FROM events`;
  assert.equal(detectStatementKind(stripSqlComments(sql).trim()), "query");
});
