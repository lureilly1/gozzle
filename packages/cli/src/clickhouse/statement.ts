export type StatementKind = "query" | "migration" | "unknown";

/**
 * Remove SQL comments (`--` line and block comments) from a statement, leaving
 * comment markers that appear inside string or backtick-quoted literals intact.
 * Block comments collapse to a single space so adjacent tokens never merge.
 *
 * Real `.sql` files carry header comments, but the query/migration validators
 * reject comments outright — so `verify <file>` strips them first.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | undefined;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      if (ch === "\\" && quote !== "`") {
        // Backslash escape inside a string literal: keep the next char verbatim.
        if (i + 1 < sql.length) {
          out += sql[i + 1];
          i += 1;
        }
      } else if (ch === quote) {
        if (sql[i + 1] === quote) {
          // Doubled quote = an escaped literal quote, not a terminator.
          out += sql[i + 1];
          i += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      // Leave the newline (or end) for the next iteration to emit.
      i -= 1;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 1; // land on the trailing '/', loop increment skips past it
      out += " ";
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Normalize the raw contents of a `.sql` file into a single statement: strip
 * comments, trim, and drop a trailing semicolon. This is the canonical form the
 * verify/equivalent commands feed to the validators.
 */
export function normalizeSqlFile(raw: string): string {
  return stripSqlComments(raw).trim().replace(/;\s*$/, "");
}

/**
 * Classify a statement by its leading keyword. Expects comments already
 * stripped. Returns "unknown" for anything that is not a SELECT/WITH query or an
 * ALTER migration.
 */
export function detectStatementKind(sql: string): StatementKind {
  const trimmed = sql.trim();
  if (/^SELECT\b/i.test(trimmed) || /^WITH\b/i.test(trimmed)) {
    return "query";
  }
  if (/^ALTER\b/i.test(trimmed)) {
    return "migration";
  }
  return "unknown";
}
