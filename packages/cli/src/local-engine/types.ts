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
}
