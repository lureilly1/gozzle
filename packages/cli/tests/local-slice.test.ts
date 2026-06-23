import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ClickHouseExportClient,
  ExportLimits
} from "../src/clickhouse/client.js";
import type {
  LocalEngine,
  LocalReplayInput
} from "../src/local-engine/types.js";
import {
  buildLocalCreateStatement,
  createLocalSlice
} from "../src/local-engine/slice.js";
import { formatLocalSliceResult } from "../src/tools/create-local-slice.js";

class FakeClient implements ClickHouseExportClient {
  exports = 0;

  constructor(
    private readonly duplicateRows: number,
    private readonly partitionRows = 3
  ) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    if (query.includes("SHOW CREATE TABLE")) {
      return [{ statement: replacingCreate }] as T[];
    }
    if (query.includes("FROM system.tables")) {
      return [tableRow] as T[];
    }
    if (query.includes("FROM system.columns")) {
      return columns as T[];
    }
    if (query.includes("GROUP BY partition_id")) {
      return [
        {
          partition_id: "202606",
          rows: String(this.partitionRows),
          bytes_on_disk: "128"
        }
      ] as T[];
    }
    if (query.includes("FROM system.parts")) {
      return [
        {
          active_parts: "1",
          rows: String(this.partitionRows),
          bytes_on_disk: "128",
          partitions: "1"
        }
      ] as T[];
    }
    if (query.includes("AS _copies")) {
      return this.duplicateRows > 0
        ? ([{ _partition_id: "202606", id: "a", _copies: "2" }] as T[])
        : [];
    }
    if (query.includes("duplicate_rows")) {
      return [
        {
          duplicate_groups: this.duplicateRows > 0 ? "1" : "0",
          duplicate_rows: String(this.duplicateRows),
          max_copies: this.duplicateRows > 0 ? "2" : "0"
        }
      ] as T[];
    }
    return [];
  }

  async exportParquet(
    _query: string,
    destination: string,
    _limits: ExportLimits
  ): Promise<{ bytesWritten: number }> {
    this.exports += 1;
    await writeFile(destination, "parquet-fixture");
    return { bytesWritten: 15 };
  }

  async close(): Promise<void> {}
}

class FakeLocalEngine implements LocalEngine {
  readonly name = "fake-chDB";
  replayInput?: LocalReplayInput;

  async replay(input: LocalReplayInput): Promise<FakeClient> {
    this.replayInput = input;
    return new FakeClient(1);
  }
}

const replacingCreate = `CREATE TABLE analytics.events
(
  id String,
  version UInt64
)
ENGINE = SharedReplacingMergeTree('/path', '{replica}', version)
PARTITION BY toYYYYMM(created_at)
ORDER BY id`;

const tableRow = {
  engine: "SharedReplacingMergeTree",
  engine_full: "SharedReplacingMergeTree('/path', '{replica}', version)",
  sorting_key: "id",
  primary_key: "id",
  partition_key: "toYYYYMM(created_at)",
  total_rows: "3",
  total_bytes: "128"
};

const columns = [
  {
    name: "id",
    type: "String",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  },
  {
    name: "version",
    type: "UInt64",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  },
  {
    name: "created_at",
    type: "DateTime",
    default_kind: "",
    default_expression: "",
    codec_expression: ""
  }
];

test("createLocalSlice writes a manifest when local proof matches source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-slice-test-"));
  const source = new FakeClient(1);
  const engine = new FakeLocalEngine();

  try {
    const result = await createLocalSlice(
      source,
      engine,
      { table: "analytics.events", defaultDatabase: "default" },
      {
        rootDirectory: root,
        maxRows: 100,
        maxBytes: 1024,
        maxTotalBytes: 1024 * 1024
      }
    );
    assert.equal(result.manifest.proof.matched, true);
    assert.equal(result.manifest.source.partitionId, "202606");
    assert.equal(result.manifest.engine, "fake-chDB");
    assert.equal(source.exports, 1);
    assert.ok(result.workspaceSizeBytes >= result.manifest.local.dataBytes);
    assert.ok(result.totalStorageBytes >= result.workspaceSizeBytes);
    assert.match(result.cleanupCommand, /^gozzle slices clean slice-/);
    assert.match(result.warnings[0], /contains production data/);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(result.workspacePath)).mode & 0o777, 0o700);
    assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600);
    const formatted = formatLocalSliceResult(result);
    assert.match(formatted, /Workspace bytes:/);
    assert.match(formatted, /Total local slice storage:/);
    assert.match(formatted, /Cleanup: gozzle slices clean slice-/);
    assert.match(formatted, /contains production data/);
    assert.match(
      engine.replayInput?.createStatement ?? "",
      /ReplacingMergeTree\(version\)/
    );

    const persisted = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(persisted.source.table, "analytics.events");
    assert.equal("password" in persisted.source, false);
    assert.doesNotMatch(
      JSON.stringify(persisted),
      /password|credential|authorization|secret/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalSlice refuses a partition above its row budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-slice-budget-"));
  const source = new FakeClient(1, 101);

  try {
    await assert.rejects(
      createLocalSlice(
        source,
        new FakeLocalEngine(),
        { table: "analytics.events", defaultDatabase: "default" },
        {
          rootDirectory: root,
          maxRows: 100,
          maxBytes: 1024,
          maxTotalBytes: 1024 * 1024
        }
      ),
      /No partial slice was created/
    );
    assert.equal(source.exports, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalSlice refuses a projected aggregate above its storage cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-slice-total-budget-"));
  const source = new FakeClient(1);

  try {
    await mkdir(join(root, "slice-incomplete"));
    await writeFile(
      join(root, "slice-incomplete", "data.parquet"),
      "x".repeat(100)
    );
    await assert.rejects(
      createLocalSlice(
        source,
        new FakeLocalEngine(),
        { table: "analytics.events", defaultDatabase: "default" },
        {
          rootDirectory: root,
          maxRows: 100,
          maxBytes: 1024,
          maxTotalBytes: 355
        }
      ),
      /100 existing.*GOZZLE_MAX_TOTAL_SLICE_BYTES=355/
    );
    assert.equal(source.exports, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalSlice removes its workspace when actual storage exceeds the cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-slice-actual-budget-"));
  const source = new FakeClient(1);
  try {
    await assert.rejects(
      createLocalSlice(
        source,
        new FakeLocalEngine(),
        { table: "analytics.events", defaultDatabase: "default" },
        {
          rootDirectory: root,
          maxRows: 100,
          maxBytes: 1024,
          maxTotalBytes: 300
        }
      ),
      /new workspace was removed/
    );
    assert.equal(source.exports, 1);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proof mismatch explains concurrent source changes and recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-slice-mismatch-"));
  try {
    const result = await createLocalSlice(
      new FakeClient(0),
      new FakeLocalEngine(),
      { table: "analytics.events", defaultDatabase: "default" },
      {
        rootDirectory: root,
        maxRows: 100,
        maxBytes: 1024,
        maxTotalBytes: 1024 * 1024
      }
    );
    assert.equal(result.manifest.proof.matched, false);
    assert.match(result.warnings.join(" "), /changed during export/);
    assert.match(result.warnings.join(" "), /recreate the slice/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildLocalCreateStatement normalizes a shared engine for chDB", () => {
  const statement = buildLocalCreateStatement({
    identifier: { database: "analytics", table: "events" },
    engine: "SharedReplacingMergeTree",
    engineFull: tableRow.engine_full,
    createStatement: replacingCreate,
    partitionBy: "toYYYYMM(created_at)",
    primaryKey: "id",
    sortingKey: "id",
    totalRows: 3,
    totalBytes: 128,
    isDistributed: false,
    isReplacingMergeTree: true,
    replacingMergeTree: { versionColumn: "version" },
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type
    })),
    parts: { activeParts: 1, rows: 3, bytesOnDisk: 128, partitions: 1 },
    eligibleChecks: {
      verifyDedup: true,
      createLocalSlice: true,
      dryRunMigration: true,
      diagnoseQuery: true
    },
    warnings: []
  });
  assert.match(statement, /CREATE DATABASE IF NOT EXISTS gozzle_slice/);
  assert.match(statement, /ENGINE = ReplacingMergeTree\(version\)/);
  assert.doesNotMatch(statement, /SharedReplacingMergeTree/);
});
