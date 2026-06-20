import { join } from "node:path";

import { Session } from "chdb";

import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import { quoteIdentifier } from "../clickhouse/identifier.js";
import type { LocalEngine, LocalReplayInput } from "./types.js";

export class ChdbLocalEngine implements LocalEngine {
  readonly name = "chDB";

  async replay(input: LocalReplayInput): Promise<ClickHouseMetadataClient> {
    const session = new Session(join(input.workspacePath, "chdb"));
    const client = new ChdbMetadataClient(session);

    try {
      session.query(input.createStatement);
      const columns = input.insertColumns.map(quoteIdentifier).join(", ");
      session.query(`
        INSERT INTO ${input.tableName} (${columns})
        SELECT ${columns}
        FROM file(${quoteStringLiteral(input.dataPath)}, Parquet)
        SETTINGS optimize_on_insert = 0
      `);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

class ChdbMetadataClient implements ClickHouseMetadataClient {
  private closed = false;

  constructor(private readonly session: Session) {}

  async ping(): Promise<boolean> {
    this.assertOpen();
    return this.session.query("SELECT 1", "JSONEachRow").trim() !== "";
  }

  async queryJson<T>(query: string): Promise<T[]> {
    this.assertOpen();
    const output = this.session.query(stripTrailingSemicolon(query), "JSONEachRow");
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.session.cleanup();
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("The chDB session is closed.");
    }
  }
}

function stripTrailingSemicolon(query: string): string {
  return query.trim().replace(/;$/, "");
}

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
