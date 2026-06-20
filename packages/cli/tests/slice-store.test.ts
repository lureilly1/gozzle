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
  listLocalSlices
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

test("lists valid slices newest first and ignores unmanaged directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "slice-old"));
  await mkdir(join(root, "slice-new"));
  await mkdir(join(root, "unmanaged"));
  await mkdir(join(root, "slice-invalid"));
  await writeFile(
    join(root, "slice-old", "manifest.json"),
    JSON.stringify(manifest("2026-06-01T00:00:00.000Z"))
  );
  await writeFile(
    join(root, "slice-new", "manifest.json"),
    JSON.stringify(manifest("2026-06-20T00:00:00.000Z"))
  );
  await writeFile(join(root, "slice-invalid", "manifest.json"), "{}");

  const slices = await listLocalSlices(root);
  assert.deepEqual(
    slices.map((slice) => slice.id),
    ["slice-new", "slice-old"]
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

  const result = await cleanLocalSlices(root, [
    "slice-safe",
    "../outside",
    "slice-invalid"
  ]);
  assert.deepEqual(
    result.removed.map((slice) => slice.id),
    ["slice-safe"]
  );
  assert.deepEqual(result.missing, ["../outside", "slice-invalid"]);
  assert.equal(
    await readFile(join(root, "slice-invalid", "keep.txt"), "utf8"),
    "do not delete"
  );
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
  assert.match(listed.stdout, /slice-cli.*analytics\.events.*verified/);

  const cleaned = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "slices", "clean", "slice-cli"],
    { env }
  );
  assert.match(cleaned.stdout, /Removed slice-cli/);
  assert.deepEqual(await listLocalSlices(root), []);
});
