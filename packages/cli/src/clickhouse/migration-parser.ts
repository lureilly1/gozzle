import { parseTableIdentifier, type TableIdentifier } from "./identifier.js";

export type MigrationClassification =
  | "metadata-only"
  | "part-rewriting"
  | "risky-materialized-column"
  | "unsupported";

export type RewriteScope = "none" | "all" | "predicate";

export interface ParsedMigration {
  statement: string;
  table: TableIdentifier;
  operation: string;
  classification: MigrationClassification;
  rewriteScope: RewriteScope;
  predicate?: string;
  reason: string;
  advice: string;
}

const ALTER_HEADER =
  /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+([\s\S]+)$/i;

export function parseMigrationStatement(input: string): ParsedMigration {
  const statement = normalizeStatement(input);
  const match = statement.match(ALTER_HEADER);
  if (!match) {
    throw new Error(
      "dry_run_migration accepts one ALTER TABLE statement using an unquoted table or database.table name."
    );
  }

  const table = parseTableIdentifier(match[1]);
  const operation = match[2].trim();
  const upper = operation.toUpperCase();

  if (startsWithWords(upper, "ON CLUSTER")) {
    return unsupported(statement, table, operation, "ON CLUSTER ALTERs are not supported in the MVP.");
  }
  if (!startsWithWords(upper, "UPDATE") && hasTopLevelComma(operation)) {
    return unsupported(
      statement,
      table,
      operation,
      "Compound ALTER commands are not supported. Dry-run each operation separately."
    );
  }
  if (startsWithWords(upper, "UPDATE")) {
    return parsePredicateMutation(statement, table, operation, "UPDATE");
  }
  if (startsWithWords(upper, "DELETE")) {
    return parsePredicateMutation(statement, table, operation, "DELETE");
  }

  if (/^MATERIALIZE\s+(COLUMN|INDEX|PROJECTION)\b/i.test(operation)) {
    const materializedColumn = /^MATERIALIZE\s+COLUMN\b/i.test(operation);
    return createResult(
      statement,
      table,
      operation,
      materializedColumn ? "risky-materialized-column" : "part-rewriting",
      "all",
      materializedColumn
        ? "MATERIALIZE COLUMN runs a mutation that populates existing parts."
        : "Materializing an index or projection builds data for existing parts.",
      "Schedule this away from peak merges and monitor system.mutations."
    );
  }

  if (/^MODIFY\s+COLUMN\b/i.test(operation)) {
    const materialized = /\bMATERIALIZED\b/i.test(operation);
    return createResult(
      statement,
      table,
      operation,
      materialized ? "risky-materialized-column" : "part-rewriting",
      "all",
      materialized
        ? "Changing a MATERIALIZED column expression can require existing data to be rebuilt."
        : "MODIFY COLUMN can rewrite existing column data; gozzle uses the full table as an upper bound.",
      "Validate type conversion and defaults on a local slice before running this ALTER."
    );
  }

  if (/^ADD\s+COLUMN\b/i.test(operation) && /\bMATERIALIZED\b/i.test(operation)) {
    return createResult(
      statement,
      table,
      operation,
      "risky-materialized-column",
      "none",
      "Adding a MATERIALIZED column is metadata-only initially, but existing parts are not physically populated until materialized or merged.",
      "Dry-run MATERIALIZE COLUMN separately if existing rows must be physically populated."
    );
  }

  if (/^(MODIFY|MATERIALIZE)\s+TTL\b/i.test(operation)) {
    return createResult(
      statement,
      table,
      operation,
      "part-rewriting",
      "all",
      "TTL changes can schedule merges or data movement across existing parts.",
      "Treat the current table footprint as the conservative affected-data bound."
    );
  }

  if (/^CLEAR\s+COLUMN\b/i.test(operation)) {
    return createResult(
      statement,
      table,
      operation,
      "part-rewriting",
      "all",
      "CLEAR COLUMN removes column data from existing parts.",
      "Confirm the column default can reconstruct cleared values before proceeding."
    );
  }

  if (isMetadataOnly(operation)) {
    const destructive = /^(DROP|RENAME)\s+COLUMN\b/i.test(operation);
    return createResult(
      statement,
      table,
      operation,
      "metadata-only",
      "none",
      destructive
        ? "This metadata operation does not rewrite table parts, but it changes or removes the visible schema immediately."
        : "This operation updates table metadata without rewriting existing parts.",
      destructive
        ? "Check dependent views and queries before applying this schema change."
        : "Review compatibility with writers and dependent views before applying it."
    );
  }

  return unsupported(
    statement,
    table,
    operation,
    "gozzle does not yet have a defensible cost model for this ALTER operation."
  );
}

function parsePredicateMutation(
  statement: string,
  table: TableIdentifier,
  operation: string,
  kind: "UPDATE" | "DELETE"
): ParsedMigration {
  const whereIndex = findTopLevelKeyword(operation, "WHERE");
  if (whereIndex === -1) {
    return unsupported(statement, table, operation, `${kind} mutation has no top-level WHERE predicate.`);
  }
  const mutationPrefix = operation.slice(0, whereIndex);
  if (findTopLevelWords(mutationPrefix, "IN PARTITION") !== -1) {
    return unsupported(
      statement,
      table,
      operation,
      `${kind} IN PARTITION mutations are not supported because the estimator does not yet preserve partition scope.`
    );
  }
  const predicateAndSettings = operation
    .slice(whereIndex + "WHERE".length)
    .trim();
  const settingsIndex = findSettingsClause(predicateAndSettings);
  const predicate = (
    settingsIndex === -1
      ? predicateAndSettings
      : predicateAndSettings.slice(0, settingsIndex)
  ).trim();
  if (!predicate) {
    return unsupported(statement, table, operation, `${kind} mutation has an empty WHERE predicate.`);
  }
  if (containsUnquotedWord(predicate, "SELECT")) {
    return unsupported(
      statement,
      table,
      operation,
      `${kind} predicates containing subqueries are not supported because dry-run predicates execute as production reads.`
    );
  }
  const externalFunction = findExternalAccessFunction(predicate);
  if (externalFunction) {
    return unsupported(
      statement,
      table,
      operation,
      `${kind} predicate calls external-access function ${externalFunction}(), which is not permitted in a production dry run.`
    );
  }
  const forbiddenClause = [
    "UNION",
    "FORMAT",
    "INTO",
    "GROUP BY",
    "ORDER BY",
    "LIMIT"
  ].find((keyword) => findTopLevelKeyword(predicate, keyword) !== -1);
  if (forbiddenClause) {
    return unsupported(
      statement,
      table,
      operation,
      `${kind} predicate contains unsupported top-level ${forbiddenClause}.`
    );
  }
  return {
    ...createResult(
      statement,
      table,
      operation,
      "part-rewriting",
      "predicate",
      `${kind} is a classic mutation that rewrites affected data parts rather than rows in place.`,
      "Review matching rows and full touched-part bytes before scheduling the mutation."
    ),
    predicate
  };
}

function createResult(
  statement: string,
  table: TableIdentifier,
  operation: string,
  classification: MigrationClassification,
  rewriteScope: RewriteScope,
  reason: string,
  advice: string
): ParsedMigration {
  return { statement, table, operation, classification, rewriteScope, reason, advice };
}

function isMetadataOnly(operation: string): boolean {
  return [
    /^ADD\s+COLUMN\b/i,
    /^DROP\s+COLUMN\b/i,
    /^RENAME\s+COLUMN\b/i,
    /^COMMENT\s+COLUMN\b/i,
    /^MODIFY\s+COMMENT\b/i,
    /^ADD\s+(INDEX|PROJECTION|CONSTRAINT)\b/i,
    /^DROP\s+(INDEX|PROJECTION|CONSTRAINT)\b/i,
    /^MODIFY\s+ORDER\s+BY\b/i,
    /^MODIFY\s+SETTING\b/i,
    /^RESET\s+SETTING\b/i,
    /^REMOVE\s+TTL\b/i
  ].some((pattern) => pattern.test(operation));
}

function unsupported(
  statement: string,
  table: TableIdentifier,
  operation: string,
  reason: string
): ParsedMigration {
  return createResult(
    statement,
    table,
    operation,
    "unsupported",
    "none",
    reason,
    "No safety verdict was inferred. Inspect this operation manually."
  );
}

function normalizeStatement(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Migration statement is required.");
  if (/--|\/\*/.test(trimmed)) {
    throw new Error("SQL comments are not accepted in dry_run_migration statements.");
  }
  const normalized = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (normalized.includes(";")) {
    throw new Error("dry_run_migration accepts exactly one statement.");
  }
  return normalized;
}

function startsWithWords(input: string, words: string): boolean {
  const pattern = words
    .split(/\s+/)
    .map((word) => escapeRegExp(word))
    .join("\\s+");
  return new RegExp(`^${pattern}(?:\\s|$)`).test(input);
}

function hasTopLevelComma(input: string): boolean {
  return scanTopLevel(input, (character) => character === ",") !== -1;
}

function findTopLevelKeyword(input: string, keyword: string): number {
  return scanTopLevel(input, (_character, index) => {
    const before = index === 0 ? " " : input[index - 1];
    const after = input[index + keyword.length] ?? " ";
    return (
      input.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Za-z0-9_]/.test(before) &&
      !/[A-Za-z0-9_]/.test(after)
    );
  });
}

function findTopLevelWords(input: string, words: string): number {
  const pattern = new RegExp(
    `^${words
      .split(/\s+/)
      .map((word) => escapeRegExp(word))
      .join("\\s+")}(?![A-Za-z0-9_])`,
    "i"
  );
  return scanTopLevel(input, (_character, index) => {
    const before = index === 0 ? " " : input[index - 1];
    return !/[A-Za-z0-9_]/.test(before) && pattern.test(input.slice(index));
  });
}

function findSettingsClause(input: string): number {
  const index = findTopLevelKeyword(input, "SETTINGS");
  if (index <= 0) return -1;
  const before = input.slice(0, index).trimEnd();
  const after = input.slice(index + "SETTINGS".length).trimStart();
  if (/\b(?:AND|OR|NOT)\s*$/i.test(before)) return -1;
  return /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(after) ? index : -1;
}

function containsUnquotedWord(input: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(maskQuoted(input));
}

function findExternalAccessFunction(input: string): string | undefined {
  const match = maskQuoted(input).match(
    /\b(url|urlCluster|remote|remoteSecure|cluster|clusterAllReplicas|file|filesystem|s3|s3Cluster|hdfs|hdfsCluster|azureBlobStorage|azureBlobStorageCluster|gcs|iceberg|deltaLake|hudi|mysql|postgresql|mongodb|redis|sqlite|odbc|jdbc|executable|executablePool)\s*\(/i
  );
  return match?.[1];
}

function maskQuoted(input: string): string {
  const characters = [...input];
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote) {
      characters[index] = " ";
      if (character === "\\") {
        index += 1;
        if (index < characters.length) characters[index] = " ";
      } else if (character === quote) {
        if (characters[index + 1] === quote) {
          index += 1;
          characters[index] = " ";
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function scanTopLevel(
  input: string,
  matches: (character: string, index: number) => boolean
): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) {
        if (input[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && matches(character, index)) return index;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
