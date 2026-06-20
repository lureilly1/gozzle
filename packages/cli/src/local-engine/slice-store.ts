import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import type { LocalSliceManifest } from "./slice.js";

export interface StoredLocalSlice {
  id: string;
  workspacePath: string;
  manifestPath: string;
  manifest: LocalSliceManifest;
}

export interface CleanLocalSlicesResult {
  removed: StoredLocalSlice[];
  missing: string[];
}

export async function listLocalSlices(rootDirectory: string): Promise<StoredLocalSlice[]> {
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const slices = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("slice-"))
      .map((entry) => readStoredSlice(rootDirectory, entry.name))
  );
  return slices
    .filter((slice): slice is StoredLocalSlice => slice !== undefined)
    .sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
}

export async function cleanLocalSlices(
  rootDirectory: string,
  ids: readonly string[] | "all"
): Promise<CleanLocalSlicesResult> {
  const slices = await listLocalSlices(rootDirectory);
  const requested = ids === "all" ? new Set(slices.map((slice) => slice.id)) : new Set(ids);
  const selected = slices.filter((slice) => requested.has(slice.id));
  for (const slice of selected) {
    await rm(slice.workspacePath, { recursive: true, force: true });
  }
  const found = new Set(selected.map((slice) => slice.id));
  return {
    removed: selected,
    missing: ids === "all" ? [] : [...requested].filter((id) => !found.has(id))
  };
}

async function readStoredSlice(
  rootDirectory: string,
  id: string
): Promise<StoredLocalSlice | undefined> {
  if (basename(id) !== id) return undefined;
  const workspacePath = join(rootDirectory, id);
  const manifestPath = join(workspacePath, "manifest.json");
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isLocalSliceManifest(value)) return undefined;
    return { id, workspacePath, manifestPath, manifest: value };
  } catch (error) {
    if ((isNodeError(error) && error.code === "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isLocalSliceManifest(value: unknown): value is LocalSliceManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.createdAt !== "string") return false;
  const source = value.source;
  const local = value.local;
  const proof = value.proof;
  return (
    typeof value.engine === "string" &&
    isRecord(source) &&
    typeof source.table === "string" &&
    typeof source.partitionId === "string" &&
    typeof source.rows === "number" &&
    typeof source.bytesOnDisk === "number" &&
    isRecord(local) &&
    typeof local.table === "string" &&
    typeof local.createStatement === "string" &&
    typeof local.dataFile === "string" &&
    typeof local.dataBytes === "number" &&
    isRecord(proof) &&
    typeof proof.sourceDuplicateRows === "number" &&
    typeof proof.localDuplicateRows === "number" &&
    typeof proof.matched === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
