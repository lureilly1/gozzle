import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { verifyEquivalent } from "../src/clickhouse/equivalent.js";
import {
  buildEquivalentStructured,
  formatEquivalentResult
} from "../src/tools/verify-equivalent.js";
import {
  parseEquivalentArgs,
  runEquivalentCommand
} from "../src/commands/equivalent.js";
import { verdictExitCode } from "../src/shared/verdict.js";

class FakeClient implements ClickHouseMetadataClient {
  readonly queries: string[] = [];
  constructor(private readonly handler: (query: string) => unknown[]) {}
  async ping(): Promise<boolean> {
    return true;
  }
  async queryJson<T>(query: string): Promise<T[]> {
    this.queries.push(query);
    return this.handler(query) as T[];
  }
  async close(): Promise<void> {}
}

const shape = (cols: Array<[string, string]>) =>
  cols.map(([name, type]) => ({ name, type }));

test("equivalent queries return correct", async () => {
  const client = new FakeClient((q) => {
    if (q.includes("DESCRIBE")) return shape([["a", "UInt64"]]);
    if (q.includes("countIf")) return [{ left_only: "0", right_only: "0" }];
    return [];
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT a FROM t",
    right: "SELECT a FROM t ORDER BY a"
  });
  assert.equal(result.verdict, "correct");
  assert.equal(result.method, "exact-source");
});

test("differing rows return incorrect with a sample", async () => {
  const client = new FakeClient((q) => {
    if (q.includes("DESCRIBE")) return shape([["a", "UInt64"]]);
    if (q.includes("countIf")) return [{ left_only: "2", right_only: "1" }];
    if (q.includes("_side, *"))
      return [
        { _side: "left", a: 5 },
        { _side: "right", a: 9 }
      ];
    return [];
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT a FROM t",
    right: "SELECT a FROM t WHERE a > 0"
  });
  assert.equal(result.verdict, "incorrect");
  assert.equal(result.differingRows, 3);
  assert.equal(result.sample.length, 2);
  assert.match(formatEquivalentResult(result), /3 differing row/);
});

test("differing result shape is incorrect and skips the diff", async () => {
  const client = new FakeClient((q) => {
    if (q.includes("DESCRIBE")) {
      return q.includes(", b")
        ? shape([
            ["a", "UInt64"],
            ["b", "String"]
          ])
        : shape([["a", "UInt64"]]);
    }
    return [];
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT a FROM t",
    right: "SELECT a, b FROM t"
  });
  assert.equal(result.verdict, "incorrect");
  assert.ok(result.shapeMismatch);
  assert.equal(
    client.queries.some((q) => q.includes("countIf")),
    false
  );
});

test("identical rows but renamed columns is incorrect (renamed)", async () => {
  const client = new FakeClient((q) => {
    if (q.includes("DESCRIBE"))
      return q.includes("AS y")
        ? shape([["y", "UInt64"]])
        : shape([["x", "UInt64"]]);
    if (q.includes("countIf")) return [{ left_only: "0", right_only: "0" }];
    return [];
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT a AS x FROM t",
    right: "SELECT a AS y FROM t"
  });
  assert.equal(result.verdict, "incorrect");
  assert.equal(result.renamed, true);
  assert.match(formatEquivalentResult(result), /column names differ/i);
});

test("non-deterministic queries are indeterminate and run nothing", async () => {
  const client = new FakeClient(() => {
    throw new Error("should not be queried");
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT rand() AS r",
    right: "SELECT rand() AS r"
  });
  assert.equal(result.verdict, "indeterminate");
  assert.match(result.indeterminateReason ?? "", /non-deterministic/);
  assert.equal(client.queries.length, 0);
});

test("a literal containing 'rand(' does not trigger non-determinism", async () => {
  const client = new FakeClient((q) => {
    if (q.includes("DESCRIBE")) return shape([["s", "String"]]);
    if (q.includes("countIf")) return [{ left_only: "0", right_only: "0" }];
    return [];
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT 'rand()' AS s",
    right: "SELECT 'rand()' AS s"
  });
  assert.equal(result.verdict, "correct");
});

test("a scan-limit abort maps to indeterminate", async () => {
  const client = new FakeClient((q) => {
    if (q.includes("DESCRIBE")) return shape([["a", "UInt64"]]);
    if (q.includes("countIf"))
      throw new Error("Code: 159. Timeout exceeded: max_execution_time");
    return [];
  });
  const result = await verifyEquivalent(client, {
    left: "SELECT a FROM big",
    right: "SELECT a FROM big2"
  });
  assert.equal(result.verdict, "indeterminate");
  assert.match(result.indeterminateReason ?? "", /too large/);
});

test("a non-SELECT side is rejected", async () => {
  const client = new FakeClient(() => []);
  await assert.rejects(
    verifyEquivalent(client, {
      left: "DELETE FROM t",
      right: "SELECT a FROM t"
    })
  );
});

test("verdictExitCode maps verdicts to exit codes", () => {
  assert.equal(verdictExitCode("correct"), 0);
  assert.equal(verdictExitCode("incorrect"), 1);
  assert.equal(verdictExitCode("indeterminate"), 2);
});

test("buildEquivalentStructured exposes the contract fields", () => {
  const s = buildEquivalentStructured({
    check: "verify_equivalent",
    verdict: "incorrect",
    method: "exact-source",
    differingRows: 3,
    leftOnly: 2,
    rightOnly: 1,
    sample: [],
    renamed: false
  });
  assert.equal(s.verdict, "incorrect");
  assert.equal(s.method, "exact-source");
  assert.equal(s.differingRows, 3);
  assert.equal(s.renamed, false);
});

test("buildEquivalentStructured can include a verification run", () => {
  const s = buildEquivalentStructured(
    {
      check: "verify_equivalent",
      verdict: "correct",
      method: "exact-source",
      differingRows: 0,
      leftOnly: 0,
      rightOnly: 0,
      sample: []
    },
    { left: "SELECT 1", right: "SELECT 1", source: "mcp" }
  );
  assert.equal(s.verificationRun?.artifact.type, "query_pair");
  assert.equal(s.verificationRun?.verdict, "pass");
});

test("parseEquivalentArgs needs two files; runEquivalentCommand guards usage", async () => {
  assert.deepEqual(parseEquivalentArgs(["a.sql", "b.sql"]).files, [
    "a.sql",
    "b.sql"
  ]);
  assert.match(
    parseEquivalentArgs(["a.sql", "--sample", "x"]).error ?? "",
    /--sample/
  );
  assert.equal(
    await runEquivalentCommand(["only-one.sql"], {} as NodeJS.ProcessEnv),
    2
  );
});
