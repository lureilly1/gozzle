import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalSliceConfig {
  rootDirectory: string;
  maxRows: number;
  maxBytes: number;
  maxTotalBytes: number;
}

export interface EphemeralSliceConfig {
  enabled: boolean;
  rootDirectory: string;
  persistOnFailure: boolean;
  cleanupAfterMinutes: number;
}

export interface LocalSliceEnv {
  GOZZLE_SLICE_DIR?: string;
  GOZZLE_MAX_SLICE_ROWS?: string;
  GOZZLE_MAX_SLICE_BYTES?: string;
  GOZZLE_MAX_TOTAL_SLICE_BYTES?: string;
  GOZZLE_EPHEMERAL_SLICE_ENABLED?: string;
  GOZZLE_EPHEMERAL_SLICE_DIR?: string;
  GOZZLE_EPHEMERAL_SLICE_PERSIST_ON_FAILURE?: string;
  GOZZLE_EPHEMERAL_SLICE_CLEANUP_AFTER_MINUTES?: string;
}

export const DEFAULT_MAX_SLICE_ROWS = 100_000;
export const DEFAULT_MAX_SLICE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_SLICE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_EPHEMERAL_CLEANUP_AFTER_MINUTES = 60;

export function readLocalSliceConfig(
  env: LocalSliceEnv = process.env
): LocalSliceConfig {
  return {
    rootDirectory:
      nonEmpty(env.GOZZLE_SLICE_DIR) ?? join(homedir(), ".gozzle", "slices"),
    maxRows: positiveInteger(env.GOZZLE_MAX_SLICE_ROWS, DEFAULT_MAX_SLICE_ROWS),
    maxBytes: positiveInteger(
      env.GOZZLE_MAX_SLICE_BYTES,
      DEFAULT_MAX_SLICE_BYTES
    ),
    maxTotalBytes: positiveInteger(
      env.GOZZLE_MAX_TOTAL_SLICE_BYTES,
      DEFAULT_MAX_TOTAL_SLICE_BYTES
    )
  };
}

export function readEphemeralSliceConfig(
  env: LocalSliceEnv = process.env
): EphemeralSliceConfig {
  return {
    enabled: booleanValue(env.GOZZLE_EPHEMERAL_SLICE_ENABLED, true),
    rootDirectory:
      nonEmpty(env.GOZZLE_EPHEMERAL_SLICE_DIR) ??
      join(homedir(), ".gozzle", "tmp"),
    persistOnFailure: booleanValue(
      env.GOZZLE_EPHEMERAL_SLICE_PERSIST_ON_FAILURE,
      false
    ),
    cleanupAfterMinutes: positiveInteger(
      env.GOZZLE_EPHEMERAL_SLICE_CLEANUP_AFTER_MINUTES,
      DEFAULT_EPHEMERAL_CLEANUP_AFTER_MINUTES
    )
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
