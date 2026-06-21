import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { diagnoseQuery } from "../src/clickhouse/query-diagnosis.js";
import { formatQueryDiagnosis } from "../src/tools/diagnose-query.js";

class FakeClient implements ClickHouseMetadataClient {
  queries: string[] = [];

  constructor(private readonly lines: string[]) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    this.queries.push(query);
    return this.lines.map((explain) => ({ explain })) as T[];
  }

  async close(): Promise<void> {}
}

test("reports full scan and missing pruning as proven findings", async () => {
  const client = new FakeClient(fullScanLines);
  const result = await diagnoseQuery(
    client,
    "SELECT count() FROM analytics.events WHERE lower(status) = 'failed'"
  );
  assert.deepEqual(
    result.findings
      .filter((finding) => finding.confidence === "proven")
      .map((finding) => finding.code),
    ["full-scan", "missing-partition-pruning", "missing-primary-key-pruning"]
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "function-wrapped-predicate"
    )
  );
  assert.equal(result.originalQueryExecuted, false);
  assert.match(client.queries[0], /^\s*EXPLAIN indexes = 1/);
  assert.match(client.queries[0], /projections = 1/);
  assert.doesNotMatch(client.queries[0], /pretty|compact/);
  assert.match(formatQueryDiagnosis(result), /3 proven pruning concern/);
  assert.doesNotMatch(formatQueryDiagnosis(result), /lower\(status\)/);
});

test("reports effective primary pruning without a full-scan finding", async () => {
  const result = await diagnoseQuery(
    new FakeClient(prunedLines),
    "SELECT count() FROM analytics.events WHERE tenant = 3 AND id = 42"
  );
  assert.equal(
    result.findings.some((finding) => finding.code === "full-scan"),
    false
  );
  assert.equal(
    result.findings.some(
      (finding) => finding.code === "missing-primary-key-pruning"
    ),
    false
  );
});

test("keeps FINAL and JOIN findings advisory", async () => {
  const result = await diagnoseQuery(
    new FakeClient(prunedLines),
    "SELECT * FROM analytics.events FINAL CROSS JOIN analytics.tenants WHERE tenant = 3"
  );
  for (const code of ["final-cost", "join-shape", "select-star"]) {
    const finding = result.findings.find((item) => item.code === code);
    assert.equal(finding?.confidence, "advisory");
  }
});

test("returns an advisory when EXPLAIN has no MergeTree evidence", async () => {
  const result = await diagnoseQuery(
    new FakeClient(["ReadFromPreparedSource (Optimized trivial count)"]),
    "SELECT count() FROM system.numbers LIMIT 10"
  );
  assert.equal(result.findings[0].code, "no-mergetree-evidence");
  assert.equal(result.findings[0].confidence, "advisory");
});

const fullScanLines = [
  "ReadFromMergeTree (analytics.events)",
  "Indexes:",
  "  MinMax",
  "    Condition: true",
  "    Parts: 4/4",
  "    Granules: 20/20",
  "  Partition",
  "    Condition: true",
  "    Parts: 4/4",
  "    Granules: 20/20",
  "  PrimaryKey",
  "    Condition: true",
  "    Parts: 4/4",
  "    Granules: 20/20",
  "  Ranges: 4"
];

const prunedLines = [
  "ReadFromMergeTree (analytics.events)",
  "Indexes:",
  "  MinMax",
  "    Condition: true",
  "    Parts: 4/4",
  "    Granules: 20/20",
  "  Partition",
  "    Condition: true",
  "    Parts: 4/4",
  "    Granules: 20/20",
  "  PrimaryKey",
  "    Condition: (tenant in [3, 3])",
  "    Parts: 2/4",
  "    Granules: 2/20",
  "  Ranges: 2"
];
