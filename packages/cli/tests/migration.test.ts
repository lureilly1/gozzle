import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { dryRunMigration } from "../src/clickhouse/migration.js";
import type { ShadowMigrationResult } from "../src/local-engine/shadow-migration.js";
import {
  buildMigrationStructured,
  formatMigrationResult,
  type ShadowOutcome
} from "../src/tools/dry-run-migration.js";

class FakeMetadataClient implements ClickHouseMetadataClient {
  queries: string[] = [];

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    this.queries.push(query);
    if (query.includes("SHOW CREATE TABLE")) {
      return [{ statement: createStatement }] as T[];
    }
    if (query.includes("FROM system.tables")) {
      return [tableRow] as T[];
    }
    if (query.includes("FROM system.columns")) {
      return columns as T[];
    }
    if (query.includes("INNER JOIN")) {
      return [
        {
          matching_rows: "7",
          affected_part_rows: "500",
          affected_parts: "2",
          affected_bytes: "1048576"
        }
      ] as T[];
    }
    if (query.includes("__gozzle_value")) {
      return [
        {
          checked_rows: "7",
          cast_failures: "0",
          null_values: "0"
        }
      ] as T[];
    }
    if (query.includes("FROM system.parts")) {
      return [
        {
          active_parts: "4",
          rows: "1000",
          bytes_on_disk: "2097152",
          partitions: "2"
        }
      ] as T[];
    }
    return [];
  }

  async close(): Promise<void> {}
}

const createStatement = `CREATE TABLE analytics.events
(
  id UInt64,
  status String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id`;

const tableRow = {
  engine: "ReplacingMergeTree",
  engine_full: "ReplacingMergeTree(version)",
  sorting_key: "id",
  primary_key: "id",
  partition_key: "",
  total_rows: "1000",
  total_bytes: "2097152"
};

const columns = [
  {
    name: "id",
    type: "UInt64",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  },
  {
    name: "status",
    type: "String",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  }
];

test("metadata-only dry run reports zero physical rewrite", async () => {
  const client = new FakeMetadataClient();
  const result = await dryRunMigration(client, {
    statement: "ALTER TABLE analytics.events ADD COLUMN source String",
    defaultDatabase: "default"
  });
  assert.equal(result.parsed.classification, "metadata-only");
  assert.equal(result.rewrite.affectedParts, 0);
  assert.equal(result.productionExecuted, false);
  assert.equal(
    client.queries.some((query) => query.includes("INNER JOIN")),
    false
  );
  const text = formatMigrationResult(result);
  assert.match(text, /Status: PASS/);
  assert.match(text, /no existing data-part rewrite expected/);
});

function shadowResult(
  overrides: Partial<ShadowMigrationResult> = {}
): ShadowMigrationResult {
  return {
    engine: "chDB",
    table: "analytics.events",
    partitionId: "202606",
    operation: "DELETE",
    sliceRows: 3,
    matchedRows: 1,
    executed: true,
    rowsDeleted: 1,
    executedStatement:
      "ALTER TABLE gozzle_slice.`events` DELETE WHERE id = 'a'",
    before: { rows: 3, duplicateGroups: 0, duplicateRows: 0, maxCopies: 0 },
    after: { rows: 2, duplicateGroups: 0, duplicateRows: 0, maxCopies: 0 },
    productionExecuted: false,
    ...overrides
  };
}

test("formatMigrationResult renders an executed shadow DELETE", async () => {
  const result = await dryRunMigration(new FakeMetadataClient(), {
    statement: "ALTER TABLE analytics.events DELETE WHERE id = 'a'",
    defaultDatabase: "default"
  });
  const text = formatMigrationResult(result, {
    kind: "result",
    result: shadowResult()
  });
  assert.match(text, /Shadow execution \(chDB\)/);
  assert.match(text, /rows deleted: 1/);
  assert.match(text, /production was not touched/);
});

test("formatMigrationResult surfaces a shadow rejection as REJECTED", async () => {
  const result = await dryRunMigration(new FakeMetadataClient(), {
    statement: "ALTER TABLE analytics.events UPDATE id = 'z' WHERE id = 'a'",
    defaultDatabase: "default"
  });
  const text = formatMigrationResult(result, {
    kind: "result",
    result: shadowResult({
      operation: "UPDATE",
      executed: false,
      executionError: "Cannot UPDATE key column `id`",
      rowsDeleted: 0,
      after: { rows: 3, duplicateGroups: 0, duplicateRows: 0, maxCopies: 0 }
    })
  });
  assert.match(text, /REJECTED/);
  assert.match(text, /Cannot UPDATE key column/);
});

test("formatMigrationResult explains a skipped shadow run", async () => {
  const result = await dryRunMigration(new FakeMetadataClient(), {
    statement: "ALTER TABLE analytics.events DELETE WHERE id = 'a'",
    defaultDatabase: "default"
  });
  const skipped: ShadowOutcome = {
    kind: "skipped",
    reason: "No partitionId was provided."
  };
  const text = formatMigrationResult(result, skipped);
  assert.match(text, /Shadow execution \(chDB\):/);
  assert.match(text, /not run: No partitionId/);
});

test("buildMigrationStructured attaches shadow result and skip reason", async () => {
  const result = await dryRunMigration(new FakeMetadataClient(), {
    statement: "ALTER TABLE analytics.events DELETE WHERE id = 'a'",
    defaultDatabase: "default"
  });
  const withResult = buildMigrationStructured(result, "mcp", undefined, {
    kind: "result",
    result: shadowResult()
  });
  assert.equal(
    (withResult as { shadow?: ShadowMigrationResult }).shadow?.executed,
    true
  );
  assert.equal("shadowSkippedReason" in withResult, false);

  const withSkip = buildMigrationStructured(result, "mcp", undefined, {
    kind: "skipped",
    reason: "chDB unavailable"
  });
  assert.equal(
    (withSkip as { shadowSkippedReason?: string }).shadowSkippedReason,
    "chDB unavailable"
  );
  assert.equal("shadow" in withSkip, false);
});

test("ADD COLUMN DEFAULT validates its expression without claiming a rewrite", async () => {
  const result = await dryRunMigration(new FakeMetadataClient(), {
    statement:
      "ALTER TABLE analytics.events ADD COLUMN status_copy String DEFAULT status",
    defaultDatabase: "default"
  });
  assert.equal(result.parsed.classification, "metadata-only");
  assert.equal(result.rewrite.evidence, "none");
  assert.deepEqual(
    result.correctness.map((finding) => finding.check),
    ["column-expression"]
  );
  assert.equal(result.correctness[0]?.status, "ok");
});

test("MODIFY COLUMN uses table metadata as a full-table upper bound", async () => {
  const client = new FakeMetadataClient();
  const result = await dryRunMigration(client, {
    statement:
      "ALTER TABLE analytics.events MODIFY COLUMN status LowCardinality(String)",
    defaultDatabase: "default"
  });
  assert.equal(result.rewrite.evidence, "table-metadata-upper-bound");
  assert.equal(result.rewrite.affectedParts, 4);
  assert.equal(result.rewrite.affectedBytes, 2097152);
  assert.deepEqual(
    result.correctness.map((finding) => finding.status),
    ["ok"]
  );
  assert.equal(
    client.queries.some((query) => query.includes("accurateCastOrNull")),
    true
  );
});

test("predicate mutation estimates matching rows and full touched parts", async () => {
  const client = new FakeMetadataClient();
  const result = await dryRunMigration(client, {
    statement:
      "ALTER TABLE analytics.events UPDATE status = 'done' WHERE id = 42",
    defaultDatabase: "default"
  });
  assert.equal(result.rewrite.evidence, "predicate-part-scan");
  assert.equal(result.rewrite.matchingRows, 7);
  assert.equal(result.rewrite.affectedPartRows, 500);
  assert.equal(result.rewrite.affectedParts, 2);
  assert.equal(result.rewrite.affectedBytes, 1048576);
  assert.deepEqual(
    result.correctness.map((finding) => finding.check),
    ["predicate", "update-expression"]
  );
  assert.deepEqual(
    result.correctness.map((finding) => finding.status),
    ["ok", "ok"]
  );
  const estimateQuery = client.queries.find((query) =>
    query.includes("INNER JOIN")
  );
  assert.match(estimateQuery ?? "", /WHERE \(id = 42\)/);
  assert.match(estimateQuery ?? "", /GROUP BY _part/);
  const text = formatMigrationResult(result);
  assert.match(text, /Status: REVIEW/);
  assert.match(text, /Read-only correctness gate/);
  assert.match(text, /proven against current data/);
  assert.match(text, /1.00 MiB/);
});

test("unsupported operation makes no rewrite claim", async () => {
  const result = await dryRunMigration(new FakeMetadataClient(), {
    statement: "ALTER TABLE analytics.events DROP PARTITION '202601'",
    defaultDatabase: "default"
  });
  assert.equal(result.parsed.classification, "unsupported");
  assert.equal(result.rewrite.evidence, "none");
  assert.match(
    formatMigrationResult(result),
    /no cost or safety claim was inferred/
  );
});

test("unsafe and partition-scoped predicates never reach the estimate query", async () => {
  for (const statement of [
    "ALTER TABLE analytics.events DELETE WHERE id IN (SELECT id FROM url('http://169.254.169.254/latest', 'JSONEachRow', 'id UInt64'))",
    "ALTER TABLE analytics.events UPDATE status = 'done' IN PARTITION '202601' WHERE id = 42"
  ]) {
    const client = new FakeMetadataClient();
    const result = await dryRunMigration(client, {
      statement,
      defaultDatabase: "default"
    });
    assert.equal(result.parsed.classification, "unsupported");
    assert.equal(result.rewrite.evidence, "none");
    assert.equal(
      client.queries.some((query) => query.includes("INNER JOIN")),
      false
    );
    assert.equal(
      client.queries.some((query) => query.includes("169.254.169.254")),
      false
    );
  }
});
