export interface TableIdentifier {
  database?: string;
  table: string;
}

export interface ResolvedTableIdentifier {
  database: string;
  table: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseTableIdentifier(input: string): TableIdentifier {
  const trimmed = input.trim();

  if (trimmed === "") {
    throw new Error("Table name is required.");
  }

  const parts = trimmed.split(".");

  if (parts.length > 2) {
    throw new Error("Use table or database.table format.");
  }

  const [database, table] = parts.length === 2 ? parts : [undefined, parts[0]];

  if (database !== undefined) {
    validateIdentifierPart(database, "database");
  }

  validateIdentifierPart(table, "table");

  return {
    database,
    table
  };
}

export function resolveTableIdentifier(
  identifier: TableIdentifier,
  defaultDatabase: string
): ResolvedTableIdentifier {
  return {
    database: identifier.database ?? defaultDatabase,
    table: identifier.table
  };
}

export function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

/** Quote a value as a ClickHouse string literal, escaping backslashes and quotes. */
export function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function formatTableIdentifier(
  identifier: ResolvedTableIdentifier
): string {
  return `${quoteIdentifier(identifier.database)}.${quoteIdentifier(identifier.table)}`;
}

function validateIdentifierPart(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label} identifier "${value}". Use an unquoted ClickHouse identifier.`
    );
  }
}
