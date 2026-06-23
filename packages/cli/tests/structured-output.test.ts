import assert from "node:assert/strict";
import test from "node:test";

import { buildDedupStructured } from "../src/tools/verify-dedup.js";
import { buildMigrationStructured } from "../src/tools/dry-run-migration.js";
import { buildDiagnosisStructured } from "../src/tools/diagnose-query.js";
import type { VerifyDedupResult } from "../src/clickhouse/dedup.js";
import type { DryRunMigrationResult } from "../src/clickhouse/migration.js";
import type {
  DiagnoseQueryResult,
  QueryFinding
} from "../src/clickhouse/query-diagnosis.js";

const HEX64 = /^[0-9a-f]{64}$/;

function dedupResult(over: Partial<VerifyDedupResult> = {}): VerifyDedupResult {
  return {
    identifier: { database: "analytics", table: "events" },
    engine: "ReplacingMergeTree(version)",
    sortingKey: "id",
    isPartitioned: false,
    eligible: true,
    totalRows: 100,
    duplicateGroups: 2,
    duplicateRows: 3,
    finalCollapsibleRows: 3,
    maxCopies: 3,
    sample: [],
    warnings: [],
    ...over
  };
}

test("buildDedupStructured maps the result and defaults scanSkipped", () => {
  const s = buildDedupStructured(dedupResult());
  assert.equal(s.table, "analytics.events");
  assert.equal(s.eligible, true);
  assert.equal(s.scanSkipped, false);
  assert.equal(s.duplicateRows, 3);
  assert.equal(s.finalCollapsibleRows, 3);
  assert.ok(!("reason" in s));
});

test("buildDedupStructured includes reason and scanSkipped when present", () => {
  const s = buildDedupStructured(
    dedupResult({ scanSkipped: true, reason: "table too large" })
  );
  assert.equal(s.scanSkipped, true);
  assert.equal(s.reason, "table too large");
});

function migrationResult(
  classification: DryRunMigrationResult["parsed"]["classification"]
): DryRunMigrationResult {
  return {
    parsed: {
      statement: "ALTER TABLE analytics.events ADD COLUMN x UInt8",
      table: { table: "events" },
      operation: "ADD COLUMN x UInt8",
      classification,
      rewriteScope: "none",
      reason: "r",
      advice: "a"
    },
    identifier: { database: "analytics", table: "events" },
    engine: "MergeTree",
    footprint: { rows: 10, activeParts: 1, bytesOnDisk: 100 },
    rewrite: {
      matchingRows: 0,
      affectedPartRows: 0,
      affectedParts: 0,
      affectedBytes: 0,
      evidence: "none"
    },
    productionExecuted: false
  };
}

test("buildMigrationStructured derives status from classification", () => {
  assert.equal(
    buildMigrationStructured(migrationResult("metadata-only")).status,
    "pass"
  );
  assert.equal(
    buildMigrationStructured(migrationResult("part-rewriting")).status,
    "review"
  );
  assert.equal(
    buildMigrationStructured(migrationResult("risky-materialized-column"))
      .status,
    "review"
  );
  assert.equal(
    buildMigrationStructured(migrationResult("unsupported")).status,
    "unknown"
  );
  const s = buildMigrationStructured(migrationResult("metadata-only"));
  assert.equal(s.table, "analytics.events");
  assert.match(s.statementSha256, HEX64);
});

function diagnosisResult(findings: QueryFinding[]): DiagnoseQueryResult {
  return {
    query: {
      query: "SELECT 1",
      hasFinal: false,
      joinCount: 0,
      hasCrossJoin: false,
      hasFunctionWrappedPredicate: false,
      hasLeadingWildcard: false,
      selectsAllColumns: false
    },
    explain: { lines: [], tables: [] },
    tableSchemas: [{ table: "analytics.events", orderBy: "id" }],
    findings,
    originalQueryExecuted: false
  };
}

const proven: QueryFinding = {
  confidence: "proven",
  severity: "high",
  code: "full-scan",
  message: "m",
  recommendation: "r"
};
const advisory: QueryFinding = {
  confidence: "advisory",
  severity: "low",
  code: "select-star",
  message: "m",
  recommendation: "r"
};

test("buildDiagnosisStructured derives status and passes through tables/findings", () => {
  assert.equal(
    buildDiagnosisStructured(diagnosisResult([proven])).status,
    "fail"
  );
  assert.equal(
    buildDiagnosisStructured(diagnosisResult([advisory])).status,
    "warn"
  );
  assert.equal(buildDiagnosisStructured(diagnosisResult([])).status, "pass");
  const s = buildDiagnosisStructured(diagnosisResult([proven, advisory]));
  assert.equal(s.findings.length, 2);
  assert.equal(s.tables[0].table, "analytics.events");
  assert.match(s.queryFingerprint, HEX64);
});
