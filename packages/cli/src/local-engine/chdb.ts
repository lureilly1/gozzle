import { join } from "node:path";
import { quoteStringLiteral } from "../clickhouse/identifier.js";

import type { Session } from "chdb";

import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import { quoteIdentifier } from "../clickhouse/identifier.js";
import type { LocalEngine, LocalReplayInput } from "./types.js";

// chDB ships a native addon that is compiled/downloaded at install time and only
// supports linux/macOS on x86_64/arm64. It is an optional dependency, so import
// it lazily: the rest of gozzle (and the MCP server) must work even where chDB
// cannot be installed.
async function loadChdbSession(): Promise<typeof import("chdb").Session> {
  try {
    const chdb = await import("chdb");
    return chdb.Session;
  } catch (error) {
    throw new Error(
      "The local slice engine (chDB) is not available on this platform. " +
        "chDB is an optional native dependency supporting linux/macOS on x86_64/arm64. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export class ChdbLocalEngine implements LocalEngine {
  readonly name = "chDB";

  async replay(input: LocalReplayInput): Promise<ClickHouseMetadataClient> {
    const session = await this.openSession(input.workspacePath);
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

  async open(workspacePath: string): Promise<ClickHouseMetadataClient> {
    return new ChdbMetadataClient(await this.openSession(workspacePath));
  }

  // chDB persists each session to its own on-disk directory. Reopening the same
  // path (after an earlier session was cleaned up) exposes the replayed table
  // again — the data survives `cleanup`; only the temporary directory removal
  // done by the caller destroys it.
  private async openSession(workspacePath: string): Promise<Session> {
    const Session = await loadChdbSession();
    return new Session(join(workspacePath, "chdb"));
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
    const output = this.session.query(
      stripTrailingSemicolon(query),
      "JSONEachRow"
    );
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
