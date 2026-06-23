import assert from "node:assert/strict";
import test from "node:test";

import {
  globToRegExp,
  matchesAnyGlob,
  parseProjectConfig
} from "../src/config/project.js";

test("parseProjectConfig reads globs and maps snake_case assumptions", () => {
  const config = parseProjectConfig(`
database: analytics
queries:
  - app/**/*.sql
  - dashboards/*.sql
migrations:
  - migrations/**/*.sql
assumptions:
  events:
    unique_by: [event_id]
    engine: ReplacingMergeTree
  raw_events:
    append_only: true
`);

  assert.equal(config.database, "analytics");
  assert.deepEqual(config.queries, ["app/**/*.sql", "dashboards/*.sql"]);
  assert.deepEqual(config.migrations, ["migrations/**/*.sql"]);
  assert.deepEqual(config.assumptions.events, {
    uniqueBy: ["event_id"],
    appendOnly: undefined,
    engine: "ReplacingMergeTree"
  });
  assert.equal(config.assumptions.raw_events.appendOnly, true);
});

test("parseProjectConfig defaults empty sections", () => {
  const config = parseProjectConfig("database: default");
  assert.deepEqual(config.queries, []);
  assert.deepEqual(config.migrations, []);
  assert.deepEqual(config.assumptions, {});
});

test("parseProjectConfig rejects unknown keys and bad types", () => {
  assert.throws(
    () => parseProjectConfig("queries: 'not-an-array'"),
    /invalid/i
  );
  assert.throws(() => parseProjectConfig("typo_key: 1"), /invalid/i);
  assert.throws(
    () => parseProjectConfig("assumptions:\n  events:\n    unique_by: 5"),
    /invalid/i
  );
});

test("globToRegExp handles *, ?, ** and **/", () => {
  assert.ok(globToRegExp("app/**/*.sql").test("app/x.sql"));
  assert.ok(globToRegExp("app/**/*.sql").test("app/a/b/x.sql"));
  assert.ok(!globToRegExp("app/**/*.sql").test("other/x.sql"));
  assert.ok(globToRegExp("dashboards/*.sql").test("dashboards/q.sql"));
  assert.ok(!globToRegExp("dashboards/*.sql").test("dashboards/sub/q.sql"));
  assert.ok(
    globToRegExp("migrations/2026_??.sql").test("migrations/2026_07.sql")
  );
});

test("matchesAnyGlob normalizes separators", () => {
  assert.ok(matchesAnyGlob("app\\models\\q.sql", ["app/**/*.sql"]));
  assert.ok(
    !matchesAnyGlob("README.md", ["app/**/*.sql", "migrations/**/*.sql"])
  );
});
