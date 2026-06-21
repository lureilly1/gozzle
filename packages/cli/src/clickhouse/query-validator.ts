export interface ValidatedQuery {
  query: string;
  hasFinal: boolean;
  joinCount: number;
  hasCrossJoin: boolean;
  hasFunctionWrappedPredicate: boolean;
  hasLeadingWildcard: boolean;
  selectsAllColumns: boolean;
}

const EXTERNAL_TABLE_FUNCTIONS = [
  "azureBlobStorage",
  "file",
  "gcs",
  "hdfs",
  "jdbc",
  "mysql",
  "odbc",
  "postgresql",
  "remote",
  "remoteSecure",
  "s3",
  "url"
];

export function validateDiagnosticQuery(input: string): ValidatedQuery {
  const query = normalizeSingleQuery(input);
  const structuralQuery = maskQuotedContent(query);
  const upper = structuralQuery.toUpperCase();
  const startsWithSelect = /^SELECT\b/i.test(query);
  const startsWithWith = /^WITH\b/i.test(query);

  if (!startsWithSelect && !startsWithWith) {
    throw new Error("diagnose_query accepts only SELECT or WITH ... SELECT queries.");
  }

  if (startsWithWith && findTopLevelKeyword(query, "SELECT") === -1) {
    throw new Error("WITH query must contain a top-level SELECT.");
  }

  for (const clause of ["INTO OUTFILE", "INTO DUMPFILE"]) {
    if (findTopLevelKeyword(query, clause) !== -1) {
      throw new Error(`Top-level ${clause} is not supported by diagnose_query.`);
    }
  }

  const formatIndex = findTopLevelKeyword(query, "FORMAT");
  if (
    formatIndex !== -1 &&
    /^FORMAT\s+[A-Za-z0-9_]+\s*$/i.test(query.slice(formatIndex))
  ) {
    throw new Error("Top-level FORMAT is not supported by diagnose_query.");
  }
  const settingsIndex = findTopLevelKeyword(query, "SETTINGS");
  if (
    settingsIndex !== -1 &&
    /^SETTINGS\s+[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(
      query.slice(settingsIndex)
    )
  ) {
    throw new Error("Top-level SETTINGS is not supported by diagnose_query.");
  }

  const externalFunction = EXTERNAL_TABLE_FUNCTIONS.find((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "i").test(structuralQuery)
  );
  if (externalFunction) {
    throw new Error(
      `External table function ${externalFunction}() is not supported by diagnose_query.`
    );
  }

  return {
    query,
    hasFinal: /\bFINAL\b/i.test(structuralQuery),
    joinCount: (upper.match(/\bJOIN\b/g) ?? []).length,
    hasCrossJoin: /\bCROSS\s+JOIN\b/i.test(structuralQuery),
    hasFunctionWrappedPredicate:
      /\b(?:WHERE|PREWHERE)\b[\s\S]*\b(?:lower|upper|toString|toDate|toDateTime|formatDateTime|substring|cast)\s*\(/i.test(
        structuralQuery
      ),
    hasLeadingWildcard: /\bLIKE\s+['"]%/i.test(query),
    selectsAllColumns: /\bSELECT\s+(?:DISTINCT\s+)?\*/i.test(structuralQuery)
  };
}

function normalizeSingleQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Query is required.");
  if (/--|\/\*/.test(trimmed)) {
    throw new Error("SQL comments are not accepted in diagnose_query queries.");
  }
  const normalized = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  if (normalized.includes(";")) {
    throw new Error("diagnose_query accepts exactly one query.");
  }
  return normalized;
}

function findTopLevelKeyword(input: string, keyword: string): number {
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
    if (depth !== 0) continue;

    const before = index === 0 ? " " : input[index - 1];
    const after = input[index + keyword.length] ?? " ";
    if (
      input.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Za-z0-9_]/.test(before) &&
      !/[A-Za-z0-9_]/.test(after)
    ) {
      return index;
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskQuotedContent(input: string): string {
  const characters = [...input];
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote) {
      characters[index] = " ";
      if (character === "\\") {
        if (index + 1 < characters.length) {
          characters[index + 1] = " ";
          index += 1;
        }
      } else if (character === quote) {
        if (input[index + 1] === quote) {
          characters[index + 1] = " ";
          index += 1;
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
