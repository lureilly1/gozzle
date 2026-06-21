import assert from "node:assert/strict";
import test from "node:test";

import { parseExplainRows } from "../src/clickhouse/explain.js";

test("parses MergeTree index conditions and selection ratios", () => {
  const result = parseExplainRows(
    explainLines.map((explain) => ({ explain }))
  );
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].table, "analytics.events");
  assert.deepEqual(result.tables[0].indexes, [
    {
      type: "MinMax",
      keys: ["day"],
      condition: "true",
      parts: { selected: 4, total: 4 },
      granules: { selected: 20, total: 20 }
    },
    {
      type: "Partition",
      keys: ["toYYYYMM(day)"],
      condition: "true",
      parts: { selected: 4, total: 4 },
      granules: { selected: 20, total: 20 }
    },
    {
      type: "PrimaryKey",
      keys: ["tenant", "id"],
      condition: "(tenant in [3, 3])",
      parts: { selected: 2, total: 4 },
      granules: { selected: 2, total: 20 }
    }
  ]);
});

const explainLines = [
  "Expression ((Project names + Projection))",
  "  ReadFromMergeTree (analytics.events)",
  "  Indexes:",
  "    MinMax",
  "      Keys:",
  "        day",
  "      Condition: true",
  "      Parts: 4/4",
  "      Granules: 20/20",
  "    Partition",
  "      Keys:",
  "        toYYYYMM(day)",
  "      Condition: true",
  "      Parts: 4/4",
  "      Granules: 20/20",
  "    PrimaryKey",
  "      Keys:",
  "        tenant",
  "        id",
  "      Condition: (tenant in [3, 3])",
  "      Parts: 2/4",
  "      Granules: 2/20",
  "    Ranges: 2"
];
