import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { LocalSliceManifest } from "./slice.js";

export type LocalSliceState = "valid" | "corrupt" | "incomplete";

export interface StoredLocalSlice {
  id: string;
  workspacePath: string;
  manifestPath: string;
  state: LocalSliceState;
  sizeBytes: number;
  modifiedAt: string;
  manifest?: LocalSliceManifest;
  detail?: string;
}

export interface CleanLocalSlicesOptions {
  ids?: readonly string[];
  all?: boolean;
  invalid?: boolean;
  olderThanMs?: number;
  now?: Date;
}

export interface CleanLocalSlicesResult {
  removed: StoredLocalSlice[];
  missing: string[];
  bytesFreed: number;
}

export async function listLocalSlices(
  rootDirectory: string
): Promise<StoredLocalSlice[]> {
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
      .map((entry) => inspectWorkspace(rootDirectory, entry.name))
  );
  return slices.sort(
    (left, right) => workspaceTime(right) - workspaceTime(left)
  );
}

export async function totalLocalSliceBytes(
  rootDirectory: string
): Promise<number> {
  return (await listLocalSlices(rootDirectory)).reduce(
    (total, slice) => total + slice.sizeBytes,
    0
  );
}

export async function workspaceSize(workspacePath: string): Promise<number> {
  const entry = await lstat(workspacePath);
  if (entry.isSymbolicLink()) return entry.size;
  if (!entry.isDirectory()) return entry.size;
  const children = await readdir(workspacePath);
  const sizes = await Promise.all(
    children.map((child) => workspaceSize(join(workspacePath, child)))
  );
  return sizes.reduce((total, bytes) => total + bytes, 0);
}

export async function cleanLocalSlices(
  rootDirectory: string,
  options: CleanLocalSlicesOptions
): Promise<CleanLocalSlicesResult> {
  const slices = await listLocalSlices(rootDirectory);
  const requested = new Set(options.ids ?? []);
  const now = (options.now ?? new Date()).getTime();
  const selected = slices.filter((slice) => {
    if (requested.has(slice.id)) {
      return options.invalid === true
        ? slice.state !== "valid"
        : slice.state === "valid";
    }
    if (options.invalid && slice.state !== "valid") return true;
    if (options.all && slice.state === "valid") return true;
    return (
      options.olderThanMs !== undefined &&
      slice.state === "valid" &&
      now - workspaceTime(slice) >= options.olderThanMs
    );
  });

  for (const slice of selected) {
    await rm(slice.workspacePath, { recursive: true, force: true });
  }
  const found = new Set(selected.map((slice) => slice.id));
  return {
    removed: selected,
    missing: [...requested].filter((id) => !found.has(id)),
    bytesFreed: selected.reduce((total, slice) => total + slice.sizeBytes, 0)
  };
}

async function inspectWorkspace(
  rootDirectory: string,
  id: string
): Promise<StoredLocalSlice> {
  if (basename(id) !== id)
    throw new Error(`Unsafe slice workspace name: ${id}`);
  const workspacePath = join(rootDirectory, id);
  const manifestPath = join(workspacePath, "manifest.json");
  const workspaceStat = await stat(workspacePath);
  let sizeBytes = 0;
  let sizeError: string | undefined;
  try {
    sizeBytes = await workspaceSize(workspacePath);
  } catch (error) {
    sizeError = `Could not measure workspace: ${formatError(error)}`;
  }

  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isLocalSliceManifest(value)) {
      return base(
        "corrupt",
        "manifest.json does not match the supported schema"
      );
    }
    if (sizeError) return base("corrupt", sizeError, value);
    return base("valid", undefined, value);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return base("incomplete", sizeError ?? "manifest.json is missing");
    }
    return base(
      "corrupt",
      `Could not read manifest.json: ${formatError(error)}`
    );
  }

  function base(
    state: LocalSliceState,
    detail?: string,
    manifest?: LocalSliceManifest
  ): StoredLocalSlice {
    return {
      id,
      workspacePath,
      manifestPath,
      state,
      sizeBytes,
      modifiedAt: workspaceStat.mtime.toISOString(),
      manifest,
      detail
    };
  }
}

function workspaceTime(slice: StoredLocalSlice): number {
  const value = slice.manifest?.createdAt ?? slice.modifiedAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLocalSliceManifest(value: unknown): value is LocalSliceManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return false;
  }
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
