import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  cleanLocalSlices,
  listLocalSlices,
  totalLocalSliceBytes
} from "../src/local-engine/slice-store.js";
import type { LocalSliceManifest } from "../src/local-engine/slice.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function manifest(createdAt: string): LocalSliceManifest {
  return {
    version: 1,
    createdAt,
    engine: "chDB",
    source: {
      table: "analytics.events",
      partitionId: "202606",
      rows: 3,
      bytesOnDisk: 128
    },
    local: {
      table: "gozzle_slice.events",
      createStatement: "CREATE TABLE gozzle_slice.events (id String)",
      dataFile: "data.parquet",
      dataBytes: 15
    },
    proof: {
      sourceDuplicateRows: 1,
      localDuplicateRows: 1,
      matched: true
    }
  };
}

test("lists valid, corrupt, and incomplete slices with actual storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-old"));
  await mkdir(join(root, "slice-new"));
  await mkdir(join(root, "unmanaged"));
  await mkdir(join(root, "slice-invalid"));
  await mkdir(join(root, "slice-incomplete"));
  await writeFile(
    join(root, "slice-old", "manifest.json"),
    JSON.stringify(manifest("2026-06-01T00:00:00.000Z"))
  );
  await writeFile(
    join(root, "slice-new", "manifest.json"),
    JSON.stringify(manifest("2026-06-20T00:00:00.000Z"))
  );
  await writeFile(join(root, "slice-invalid", "manifest.json"), "{}");
  await writeFile(join(root, "slice-incomplete", "data.parquet"), "12345");

  const slices = await listLocalSlices(root);
  assert.equal(slices.length, 4);
  assert.equal(
    slices.find((slice) => slice.id === "slice-new")?.state,
    "valid"
  );
  assert.equal(
    slices.find((slice) => slice.id === "slice-invalid")?.state,
    "corrupt"
  );
  const incomplete = slices.find((slice) => slice.id === "slice-incomplete");
  assert.equal(incomplete?.state, "incomplete");
  assert.equal(incomplete?.sizeBytes, 5);
  assert.equal(
    await totalLocalSliceBytes(root),
    slices.reduce((total, slice) => total + slice.sizeBytes, 0)
  );
});

test("cleanup removes only selected manifest-backed slices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-safe"));
  await mkdir(join(root, "slice-invalid"));
  await writeFile(
    join(root, "slice-safe", "manifest.json"),
    JSON.stringify(manifest("2026-06-20T00:00:00.000Z"))
  );
  await writeFile(join(root, "slice-invalid", "keep.txt"), "do not delete");

  const result = await cleanLocalSlices(root, {
    ids: ["slice-safe", "../outside", "slice-invalid"]
  });
  assert.deepEqual(
    result.removed.map((slice) => slice.id),
    ["slice-safe"]
  );
  assert.deepEqual(result.missing, ["../outside", "slice-invalid"]);
  assert.ok(result.bytesFreed > 0);
  assert.equal(
    await readFile(join(root, "slice-invalid", "keep.txt"), "utf8"),
    "do not delete"
  );
});

test("age cleanup removes only old valid slices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-age-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ["slice-old", "slice-new", "slice-incomplete"]) {
    await mkdir(join(root, id));
  }
  await writeFile(
    join(root, "slice-old", "manifest.json"),
    JSON.stringify(manifest("2026-06-01T00:00:00.000Z"))
  );
  await writeFile(
    join(root, "slice-new", "manifest.json"),
    JSON.stringify(manifest("2026-06-19T00:00:00.000Z"))
  );
  const result = await cleanLocalSlices(root, {
    olderThanMs: 7 * 24 * 60 * 60 * 1000,
    now: new Date("2026-06-20T00:00:00.000Z")
  });
  assert.deepEqual(
    result.removed.map((slice) => slice.id),
    ["slice-old"]
  );
  assert.equal((await listLocalSlices(root)).length, 2);
});

test("invalid cleanup explicitly removes corrupt and incomplete direct children", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-invalid-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-corrupt"));
  await mkdir(join(root, "slice-incomplete"));
  await mkdir(join(root, "unmanaged"));
  await writeFile(join(root, "slice-corrupt", "manifest.json"), "not-json");
  await writeFile(join(root, "unmanaged", "keep.txt"), "keep");

  const result = await cleanLocalSlices(root, { invalid: true });
  assert.deepEqual(result.removed.map((slice) => slice.id).sort(), [
    "slice-corrupt",
    "slice-incomplete"
  ]);
  assert.equal(
    await readFile(join(root, "unmanaged", "keep.txt"), "utf8"),
    "keep"
  );
});

test("invalid cleanup cannot remove a valid workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-invalid-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-valid"));
  await writeFile(
    join(root, "slice-valid", "manifest.json"),
    JSON.stringify(manifest("2026-06-01T00:00:00.000Z"))
  );
  const result = await cleanLocalSlices(root, {
    invalid: true,
    ids: ["slice-valid"]
  });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.missing, ["slice-valid"]);
  assert.equal((await listLocalSlices(root))[0]?.state, "valid");
});

test("listing a missing root returns no slices", async () => {
  const root = join(tmpdir(), `gozzle-missing-${randomUUID()}`);
  assert.deepEqual(await listLocalSlices(root), []);
});

test("slices CLI lists and cleans a persisted slice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-cli-slices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-cli"));
  await writeFile(
    join(root, "slice-cli", "manifest.json"),
    JSON.stringify(manifest("2026-06-20T00:00:00.000Z"))
  );
  const env = { ...process.env, GOZZLE_SLICE_DIR: root };

  const listed = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "slices"],
    { env }
  );
  assert.match(listed.stdout, /WARNING: Local slices contain production data/);
  assert.match(
    listed.stdout,
    /slice-cli.*valid.*analytics\.events.*size=.*verified/
  );
  assert.match(listed.stdout, /Total: .* in 1 workspace/);

  const cleaned = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "slices", "clean", "slice-cli"],
    { env }
  );
  assert.match(cleaned.stdout, /Removed slice-cli/);
  assert.deepEqual(await listLocalSlices(root), []);
});

test("slices CLI supports age-based and explicit invalid cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-cli-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-old"));
  await mkdir(join(root, "slice-corrupt"));
  await writeFile(
    join(root, "slice-old", "manifest.json"),
    JSON.stringify(manifest("2020-01-01T00:00:00.000Z"))
  );
  await writeFile(join(root, "slice-corrupt", "manifest.json"), "{");
  const env = { ...process.env, GOZZLE_SLICE_DIR: root };

  const aged = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "slices", "clean", "--older-than", "7d"],
    { env }
  );
  assert.match(aged.stdout, /Removed slice-old/);
  assert.equal((await listLocalSlices(root))[0]?.state, "corrupt");

  const invalid = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "slices", "clean", "--invalid"],
    { env }
  );
  assert.match(invalid.stdout, /Removed slice-corrupt/);
  assert.deepEqual(await listLocalSlices(root), []);
});
