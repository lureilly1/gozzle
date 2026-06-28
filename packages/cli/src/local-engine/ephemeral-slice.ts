import { rm } from "node:fs/promises";

import type { ClickHouseExportClient } from "../clickhouse/client.js";
import type {
  EphemeralSliceConfig,
  LocalSliceConfig
} from "../config/local-slice.js";
import {
  createLocalSlice,
  type CreateLocalSliceOptions,
  type LocalSliceResult
} from "./slice.js";
import type { LocalEngine } from "./types.js";

export interface EphemeralSliceOptions {
  source: ClickHouseExportClient;
  localEngine: LocalEngine;
  slice: CreateLocalSliceOptions;
  localSliceConfig: LocalSliceConfig;
  ephemeralConfig: EphemeralSliceConfig;
  createSlice?: typeof createLocalSlice;
}

export async function withEphemeralSlice<T>(
  options: EphemeralSliceOptions,
  run: (slice: LocalSliceResult) => Promise<T>
): Promise<T> {
  if (!options.ephemeralConfig.enabled) {
    throw new Error("Ephemeral local slices are disabled.");
  }

  let slice: LocalSliceResult | undefined;
  let failed = false;
  try {
    slice = await (options.createSlice ?? createLocalSlice)(
      options.source,
      options.localEngine,
      options.slice,
      {
        ...options.localSliceConfig,
        rootDirectory: options.ephemeralConfig.rootDirectory
      }
    );
    return await run(slice);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (slice && shouldRemoveSlice(options.ephemeralConfig, failed)) {
      await rm(slice.workspacePath, { recursive: true, force: true });
    }
  }
}

export function shouldRemoveSlice(
  config: EphemeralSliceConfig,
  failed: boolean
): boolean {
  return !failed || !config.persistOnFailure;
}
