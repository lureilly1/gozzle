import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClickHouseExportClient } from "../src/clickhouse/client.js";
import type { LocalSliceResult } from "../src/local-engine/slice.js";
import {
  shouldRemoveSlice,
  withEphemeralSlice
} from "../src/local-engine/ephemeral-slice.js";
import type { LocalEngine } from "../src/local-engine/types.js";

const source = {} as ClickHouseExportClient;
const localEngine = {} as LocalEngine;

function result(workspacePath: string): LocalSliceResult {
  return {
    workspacePath,
    manifestPath: join(workspacePath, "manifest.json"),
    manifest: {} as LocalSliceResult["manifest"],
    sourceProof: {} as LocalSliceResult["sourceProof"],
    localProof: {} as LocalSliceResult["localProof"],
    warnings: [],
    workspaceSizeBytes: 0,
    totalStorageBytes: 0,
    cleanupCommand: "gozzle slices clean test"
  };
}

test("withEphemeralSlice removes the workspace after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-ephemeral-root-"));
  let workspace = "";
  const value = await withEphemeralSlice(
    {
      source,
      localEngine,
      slice: { table: "events", defaultDatabase: "default" },
      localSliceConfig: {
        rootDirectory: root,
        maxRows: 1,
        maxBytes: 1,
        maxTotalBytes: 1
      },
      ephemeralConfig: {
        enabled: true,
        rootDirectory: root,
        persistOnFailure: false,
        cleanupAfterMinutes: 60
      },
      createSlice: async () => {
        workspace = await mkdtemp(join(root, "slice-"));
        return result(workspace);
      }
    },
    async () => "ok"
  );

  assert.equal(value, "ok");
  await assert.rejects(stat(workspace));
});

test("withEphemeralSlice can persist workspace on callback failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "gozzle-ephemeral-root-"));
  let workspace = "";
  await assert.rejects(
    withEphemeralSlice(
      {
        source,
        localEngine,
        slice: { table: "events", defaultDatabase: "default" },
        localSliceConfig: {
          rootDirectory: root,
          maxRows: 1,
          maxBytes: 1,
          maxTotalBytes: 1
        },
        ephemeralConfig: {
          enabled: true,
          rootDirectory: root,
          persistOnFailure: true,
          cleanupAfterMinutes: 60
        },
        createSlice: async () => {
          workspace = await mkdtemp(join(root, "slice-"));
          return result(workspace);
        }
      },
      async () => {
        throw new Error("verification failed");
      }
    ),
    /verification failed/
  );

  assert.ok((await stat(workspace)).isDirectory());
});

test("shouldRemoveSlice keeps only opted-in failure workspaces", () => {
  assert.equal(
    shouldRemoveSlice(
      {
        enabled: true,
        rootDirectory: "/tmp/x",
        persistOnFailure: false,
        cleanupAfterMinutes: 60
      },
      true
    ),
    true
  );
  assert.equal(
    shouldRemoveSlice(
      {
        enabled: true,
        rootDirectory: "/tmp/x",
        persistOnFailure: true,
        cleanupAfterMinutes: 60
      },
      true
    ),
    false
  );
});
