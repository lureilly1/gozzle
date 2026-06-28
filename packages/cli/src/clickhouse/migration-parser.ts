import { parseTableIdentifier, type TableIdentifier } from "./identifier.js";
import {
  escapeRegExp,
  findTopLevelKeyword,
  findTopLevelWords,
  maskQuoted,
  scanTopLevel,
  splitTopLevel
} from "./sql-scan.js";

export type MigrationClassification =
  | "metadata-only"
  | "part-rewriting"
  | "risky-materialized-column"
  | "unsupported";

export type RewriteScope = "none" | "all" | "predicate";

/** A `column = expression` pair from an UPDATE mutation. */
export interface MigrationAssignment {
  column: string;
  expression: string;
}

/** The column and target type of a plain `MODIFY COLUMN <name> <type>`. */
export interface MigrationColumnChange {
  column: string;
  type: string;
}

/** A DEFAULT/MATERIALIZED column expression that can be evaluated read-only. */
export interface MigrationColumnExpression {
  column: string;
  type: string;
  kind: "DEFAULT" | "MATERIALIZED";
  expression: string;
}

export interface ParsedMigration {
  statement: string;
  table: TableIdentifier;
  operation: string;
  classification: MigrationClassification;
  rewriteScope: RewriteScope;
  predicate?: string;
  /** SET assignments, when the operation is an UPDATE mutation. */
  assignments?: MigrationAssignment[];
  /** Column + target type, when the operation is a plain MODIFY COLUMN. */
  columnChange?: MigrationColumnChange;
  /** Column expression, when ADD/MODIFY COLUMN carries DEFAULT/MATERIALIZED. */
  columnExpression?: MigrationColumnExpression;
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
    return unsupported(
      statement,
      table,
      operation,
      "ON CLUSTER ALTERs are not supported in the MVP."
    );
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
    const result = createResult(
      statement,
      table,
      operation,
      materialized ? "risky-materialized-column" : "part-rewriting",
      "all",
      materialized
        ? "Changing a MATERIALIZED column expression can require existing data to be rebuilt."
        : "MODIFY COLUMN can rewrite existing column data; gozzle uses the full table as an upper bound.",
      "Review the type conversion below before running this ALTER."
    );
    const definition = parseColumnDefinition(operation, "MODIFY");
    return {
      ...result,
      ...(definition && !materialized
        ? { columnChange: { column: definition.column, type: definition.type } }
        : {}),
      ...(definition?.expression
        ? { columnExpression: definition.expression }
        : {})
    };
  }

  if (
    /^ADD\s+COLUMN\b/i.test(operation) &&
    /\bMATERIALIZED\b/i.test(operation)
  ) {
    const result = createResult(
      statement,
      table,
      operation,
      "risky-materialized-column",
      "none",
      "Adding a MATERIALIZED column is metadata-only initially, but existing parts are not physically populated until materialized or merged.",
      "Dry-run MATERIALIZE COLUMN separately if existing rows must be physically populated."
    );
    const definition = parseColumnDefinition(operation, "ADD");
    return definition?.expression
      ? { ...result, columnExpression: definition.expression }
      : result;
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
    const result = createResult(
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
    const definition = /^ADD\s+COLUMN\b/i.test(operation)
      ? parseColumnDefinition(operation, "ADD")
      : undefined;
    return definition?.expression
      ? { ...result, columnExpression: definition.expression }
      : result;
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
    return unsupported(
      statement,
      table,
      operation,
      `${kind} mutation has no top-level WHERE predicate.`
    );
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
    return unsupported(
      statement,
      table,
      operation,
      `${kind} mutation has an empty WHERE predicate.`
    );
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
  const assignments =
    kind === "UPDATE"
      ? parseAssignments(operation.slice("UPDATE".length, whereIndex))
      : [];
  if (kind === "UPDATE" && assignments.length === 0) {
    return unsupported(
      statement,
      table,
      operation,
      "UPDATE mutation has no parseable assignments."
    );
  }
  const base = {
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
  if (kind === "UPDATE") return { ...base, assignments };
  return base;
}

/** Parse `col = expr, col2 = expr2` (top-level commas, first top-level `=`). */
function parseAssignments(text: string): MigrationAssignment[] {
  return splitTopLevel(text, ",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = scanTopLevel(part, (character) => character === "=");
      if (eq <= 0) return undefined;
      const column = stripBackticks(part.slice(0, eq).trim());
      const expression = part.slice(eq + 1).trim();
      return column && expression ? { column, expression } : undefined;
    })
    .filter((entry): entry is MigrationAssignment => entry !== undefined);
}

const COLUMN_DEFINITION_HEADERS = {
  ADD: /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/i,
  MODIFY:
    /^MODIFY\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/i
};

// Clauses that can trail the type in a MODIFY COLUMN, so we keep only the type.
const COLUMN_TYPE_TERMINATORS = [
  "DEFAULT",
  "MATERIALIZED",
  "ALIAS",
  "EPHEMERAL",
  "CODEC",
  "TTL",
  "COMMENT",
  "SETTINGS",
  "REMOVE",
  "AFTER",
  "FIRST"
];

const COLUMN_EXPRESSION_TERMINATORS = [
  "CODEC",
  "TTL",
  "COMMENT",
  "SETTINGS",
  "AFTER",
  "FIRST"
];

function parseColumnDefinition(
  operation: string,
  action: keyof typeof COLUMN_DEFINITION_HEADERS
):
  | {
      column: string;
      type: string;
      expression?: MigrationColumnExpression;
    }
  | undefined {
  const match = operation.match(COLUMN_DEFINITION_HEADERS[action]);
  if (!match) return undefined;
  const column = stripBackticks(match[1]);
  let type = match[2].trim();
  const expression = parseColumnExpression(column, type);
  const cut = COLUMN_TYPE_TERMINATORS.map((keyword) =>
    findTopLevelKeyword(type, keyword)
  ).filter((index) => index > 0);
  if (cut.length > 0) type = type.slice(0, Math.min(...cut)).trim();
  return column && type ? { column, type, expression } : undefined;
}

function parseColumnExpression(
  column: string,
  typeAndClauses: string
): MigrationColumnExpression | undefined {
  const kind = ["DEFAULT", "MATERIALIZED"].find(
    (keyword) => findTopLevelKeyword(typeAndClauses, keyword) > 0
  ) as MigrationColumnExpression["kind"] | undefined;
  if (!kind) return undefined;
  const kindIndex = findTopLevelKeyword(typeAndClauses, kind);
  const type = typeAndClauses.slice(0, kindIndex).trim();
  let expression = typeAndClauses.slice(kindIndex + kind.length).trim();
  const cut = COLUMN_EXPRESSION_TERMINATORS.map((keyword) =>
    findTopLevelKeyword(expression, keyword)
  ).filter((index) => index > 0);
  if (cut.length > 0) expression = expression.slice(0, Math.min(...cut)).trim();
  return column && type && expression
    ? { column, type, kind, expression }
    : undefined;
}

function stripBackticks(value: string): string {
  return value.startsWith("`") && value.endsWith("`")
    ? value.slice(1, -1)
    : value;
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
  return {
    statement,
    table,
    operation,
    classification,
    rewriteScope,
    reason,
    advice
  };
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
    throw new Error(
      "SQL comments are not accepted in dry_run_migration statements."
    );
  }
  const normalized = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
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
