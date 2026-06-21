import assert from "node:assert/strict";
import test from "node:test";

import { validateDiagnosticQuery } from "../src/clickhouse/query-validator.js";

test("accepts SELECT and WITH queries", () => {
  assert.equal(validateDiagnosticQuery("SELECT count() FROM events").query, "SELECT count() FROM events");
  assert.equal(
    validateDiagnosticQuery("WITH 42 AS tenant SELECT * FROM events WHERE tenant_id = tenant").selectsAllColumns,
    true
  );
});

test("detects static query-shape advisories", () => {
  const query = validateDiagnosticQuery(`
    SELECT *
    FROM events FINAL
    CROSS JOIN tenants
    WHERE lower(status) LIKE '%failed'
  `);
  assert.equal(query.hasFinal, true);
  assert.equal(query.joinCount, 1);
  assert.equal(query.hasCrossJoin, true);
  assert.equal(query.hasFunctionWrappedPredicate, true);
  assert.equal(query.hasLeadingWildcard, true);
  assert.equal(query.selectsAllColumns, true);
});

test("rejects non-SELECT, multiple statements, and output clauses", () => {
  assert.throws(
    () => validateDiagnosticQuery("ALTER TABLE events ADD COLUMN x UInt8"),
    /only SELECT/
  );
  assert.throws(
    () => validateDiagnosticQuery("SELECT 1; SELECT 2"),
    /exactly one query/
  );
  assert.throws(
    () => validateDiagnosticQuery("SELECT * FROM events FORMAT JSONEachRow"),
    /FORMAT is not supported/
  );
});

test("rejects external table functions", () => {
  for (const [query, functionName] of [
    ["SELECT * FROM s3('https://example.com/a.parquet')", "s3"],
    ["SELECT * FROM s3Cluster('cluster', 'https://example.com/a.parquet')", "s3Cluster"],
    ["SELECT * FROM filesystem()", "filesystem"],
    ["SELECT * FROM clusterAllReplicas('cluster', system, numbers)", "clusterAllReplicas"]
  ]) {
    assert.throws(
      () => validateDiagnosticQuery(query),
      new RegExp(`External table function ${functionName}`)
    );
  }
});

test("rejects output clauses with flexible whitespace", () => {
  for (const query of [
    "SELECT 1 INTO OUTFILE '/tmp/result'",
    "SELECT 1 INTO   OUTFILE '/tmp/result'",
    "SELECT 1 INTO\nOUTFILE '/tmp/result'",
    "SELECT 1 INTO\tDUMPFILE '/tmp/result'"
  ]) {
    assert.throws(() => validateDiagnosticQuery(query), /Top-level INTO/);
  }
});

test("does not treat literals or similarly named columns as query clauses", () => {
  const query = validateDiagnosticQuery(
    "SELECT format, settings, 'FINAL JOIN s3(' AS message FROM events"
  );
  assert.equal(query.hasFinal, false);
  assert.equal(query.joinCount, 0);
});
