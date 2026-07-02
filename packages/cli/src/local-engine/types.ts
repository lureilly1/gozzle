import type { ClickHouseMetadataClient } from "../clickhouse/client.js";

export interface LocalReplayInput {
  workspacePath: string;
  createStatement: string;
  dataPath: string;
  tableName: string;
  insertColumns: string[];
}

export interface LocalEngine {
  readonly name: string;
  replay(input: LocalReplayInput): Promise<ClickHouseMetadataClient>;
  /**
   * Reopen a client against an already-replayed workspace, without recreating
   * or reloading data. Used to shadow-execute statements (e.g. an ALTER
   * mutation) against a slice that `replay` persisted to disk.
   */
  open(workspacePath: string): Promise<ClickHouseMetadataClient>;
}
