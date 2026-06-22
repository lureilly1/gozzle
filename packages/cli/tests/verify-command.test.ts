import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import { mkdir } from "node:fs/promises";
import {
  aggregateExitCode,
  discoverConfiguredFiles,
  parseVerifyArgs,
  runVerifyCommand,
  selectVerifiableFiles,
  verifyFiles
} from "../src/commands/verify.js";
import type { GozzleProjectConfig } from "../src/config/project.js";

class FakeMetadataClient implements ClickHouseMetadataClient {
  constructor(private readonly responses: Record<string, unknown[]>) {}
  async ping(): Promise<boolean> {
    return true;
  }
  async queryJson<T>(query: string): Promise<T[]> {
    const key = Object.keys(this.responses).find((c) => query.includes(c));
    return (key ? this.responses[key] : []) as T[];
  }
  async close(): Promise<void> {}
}

function explain(lines: string[]): { explain: string }[] {
  return lines.map((line) => ({ explain: line }));
}

const FULL_SCAN_EXPLAIN = explain([
  "ReadFromMergeTree (default.events)",
  "  Indexes:",
  "    PrimaryKey",
  "      Condition: true",
  "      Parts: 5/5",
  "      Granules: 100/100"
]);

const PRUNED_EXPLAIN = explain([
  "ReadFromMergeTree (default.events)",
  "  Indexes:",
  "    PrimaryKey",
  "      Condition: (id in [10, 20])",
  "      Parts: 1/5",
  "      Granules: 10/100"
]);

const MIGRATION_RESPONSES = {
  "SHOW CREATE TABLE": [
    { statement: "CREATE TABLE default.t (id UInt64) ENGINE = MergeTree ORDER BY id" }
  ],
  "FROM system.tables": [
    {
      engine: "MergeTree",
      engine_full: "MergeTree",
      sorting_key: "id",
      primary_key: "id",
      partition_key: "",
      total_rows: "10",
      total_bytes: "100"
    }
  ],
  "FROM system.columns": [],
  "FROM system.parts": [
    { active_parts: "1", rows: "10", bytes_on_disk: "100", partitions: "1" }
  ]
};

async function withTempFile(
  name: string,
  contents: string,
  run: (path: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gozzle-verify-"));
  try {
    const path = join(dir, name);
    await writeFile(path, contents, "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NO_AUDIT = {} as NodeJS.ProcessEnv;
const OPTS = { strict: false, json: false };

test("parseVerifyArgs collects files and flags, rejects unknown flags", () => {
  assert.deepEqual(parseVerifyArgs(["a.sql", "--strict", "b.sql"]), {
    files: ["a.sql", "b.sql"],
    options: { strict: true, json: false, changed: false, all: false }
  });
  assert.equal(parseVerifyArgs(["--bogus"]).error, "Unknown flag: --bogus");
});

test("parseVerifyArgs handles --changed and --diff <range>", () => {
  assert.equal(parseVerifyArgs(["--changed"]).options.changed, true);
  assert.equal(
    parseVerifyArgs(["--diff", "origin/main...HEAD"]).options.diff,
    "origin/main...HEAD"
  );
  assert.match(parseVerifyArgs(["--diff"]).error ?? "", /--diff requires a git range/);
  assert.match(
    parseVerifyArgs(["--diff", "--strict"]).error ?? "",
    /--diff requires a git range/
  );
});

test("parseVerifyArgs handles --all", () => {
  assert.equal(parseVerifyArgs(["--all"]).options.all, true);
  assert.equal(parseVerifyArgs([]).options.all, false);
});

test("discoverConfiguredFiles walks the tree and matches config globs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gozzle-discover-"));
  try {
    await mkdir(join(dir, "app", "models"), { recursive: true });
    await mkdir(join(dir, "migrations"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "app", "models", "revenue.sql"), "SELECT 1", "utf8");
    await writeFile(join(dir, "migrations", "001.sql"), "ALTER TABLE t ADD COLUMN x UInt8", "utf8");
    await writeFile(join(dir, "README.md"), "# hi", "utf8");
    await writeFile(join(dir, "node_modules", "pkg", "ignored.sql"), "SELECT 1", "utf8");

    const config: GozzleProjectConfig = {
      queries: ["app/**/*.sql"],
      migrations: ["migrations/**/*.sql"],
      assumptions: {}
    };
    const found = (await discoverConfiguredFiles(dir, config)).sort();
    assert.deepEqual(found, [
      join(dir, "app", "models", "revenue.sql"),
      join(dir, "migrations", "001.sql")
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selectVerifiableFiles filters by config globs, else by .sql", () => {
  const files = [
    "app/models/revenue.sql",
    "migrations/2026_add.sql",
    "README.md",
    "src/index.ts"
  ];
  assert.deepEqual(selectVerifiableFiles(files), [
    "app/models/revenue.sql",
    "migrations/2026_add.sql"
  ]);

  const config: GozzleProjectConfig = {
    queries: ["app/**/*.sql"],
    migrations: ["migrations/**/*.sql"],
    assumptions: {}
  };
  assert.deepEqual(selectVerifiableFiles([...files, "dashboards/x.sql"], config), [
    "app/models/revenue.sql",
    "migrations/2026_add.sql"
  ]);
});

test("aggregateExitCode: error > findings > clean", () => {
  const mk = (failing: boolean, errored: boolean) =>
    ({ failing, errored }) as never;
  assert.equal(aggregateExitCode([mk(false, false)]), 0);
  assert.equal(aggregateExitCode([mk(true, false)]), 1);
  assert.equal(aggregateExitCode([mk(true, false), mk(false, true)]), 2);
});

test("a proven full-scan query fails the gate (exit 1)", async () => {
  const client = new FakeMetadataClient({ EXPLAIN: FULL_SCAN_EXPLAIN });
  await withTempFile("q.sql", "-- daily\nSELECT * FROM events", async (path) => {
    const outcomes = await verifyFiles(client, [path], "default", OPTS, NO_AUDIT);
    assert.equal(outcomes[0].kind, "query");
    assert.equal(outcomes[0].failing, true);
    assert.equal(aggregateExitCode(outcomes), 1);
  });
});

test("an advisory-only query passes, but fails under --strict", async () => {
  const client = new FakeMetadataClient({ EXPLAIN: PRUNED_EXPLAIN });
  await withTempFile("q.sql", "SELECT * FROM events FINAL", async (path) => {
    const lenient = await verifyFiles(client, [path], "default", OPTS, NO_AUDIT);
    assert.equal(lenient[0].failing, false);
    assert.equal(aggregateExitCode(lenient), 0);

    const strict = await verifyFiles(
      client,
      [path],
      "default",
      { strict: true, json: false },
      NO_AUDIT
    );
    assert.equal(strict[0].failing, true);
    assert.equal(aggregateExitCode(strict), 1);
  });
});

test("a metadata-only migration passes (exit 0)", async () => {
  const client = new FakeMetadataClient(MIGRATION_RESPONSES);
  await withTempFile(
    "m.sql",
    "ALTER TABLE t ADD COLUMN x UInt8",
    async (path) => {
      const outcomes = await verifyFiles(client, [path], "default", OPTS, NO_AUDIT);
      assert.equal(outcomes[0].kind, "migration");
      assert.equal(outcomes[0].failing, false);
      assert.equal(aggregateExitCode(outcomes), 0);
    }
  );
});

test("an unknown statement is an operational error (exit 2)", async () => {
  const client = new FakeMetadataClient({});
  await withTempFile("x.sql", "INSERT INTO t VALUES (1)", async (path) => {
    const outcomes = await verifyFiles(client, [path], "default", OPTS, NO_AUDIT);
    assert.equal(outcomes[0].errored, true);
    assert.equal(aggregateExitCode(outcomes), 2);
  });
});

test("a missing file is an operational error (exit 2)", async () => {
  const client = new FakeMetadataClient({});
  const outcomes = await verifyFiles(
    client,
    ["/no/such/file.sql"],
    "default",
    OPTS,
    NO_AUDIT
  );
  assert.equal(outcomes[0].errored, true);
  assert.equal(aggregateExitCode(outcomes), 2);
});

test("runVerifyCommand returns usage error without files", async () => {
  assert.equal(await runVerifyCommand([], NO_AUDIT), 2);
  assert.equal(await runVerifyCommand(["--bogus"], NO_AUDIT), 2);
});
