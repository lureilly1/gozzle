import {
  detectStatementKind,
  normalizeSqlFile
} from "../clickhouse/statement.js";

export type ArtifactInput =
  | { source: "content"; content: string; path?: string }
  | { source: "query_pair"; left: string; right: string; path?: string };

export type ArtifactType = "query" | "query_pair" | "migration" | "unknown";

export interface ClassifiedArtifact {
  type: ArtifactType;
  statement?: string;
  left?: string;
  right?: string;
  path?: string;
  reason?: string;
}

export function classifyArtifact(input: ArtifactInput): ClassifiedArtifact {
  if (input.source === "query_pair") {
    return {
      type: "query_pair",
      left: normalizeSqlFile(input.left),
      right: normalizeSqlFile(input.right),
      path: input.path
    };
  }

  const statement = normalizeSqlFile(input.content);
  const kind = detectStatementKind(statement);
  if (kind === "query") {
    return { type: "query", statement, path: input.path };
  }
  if (kind === "migration") {
    return { type: "migration", statement, path: input.path };
  }
  return {
    type: "unknown",
    statement,
    path: input.path,
    reason: "Not a supported SELECT/WITH or ALTER statement."
  };
}
