import {
  escapeRegExp,
  findTopLevelKeyword,
  findTopLevelWords,
  maskQuoted
} from "./sql-scan.js";

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
  "azureBlobStorageCluster",
  "cluster",
  "clusterAllReplicas",
  "deltaLake",
  "executable",
  "executablePool",
  "file",
  "filesystem",
  "gcs",
  "hdfs",
  "hdfsCluster",
  "hudi",
  "iceberg",
  "jdbc",
  "mongodb",
  "mysql",
  "odbc",
  "postgresql",
  "redis",
  "remote",
  "remoteSecure",
  "s3",
  "s3Cluster",
  "sqlite",
  "url"
];

export function validateDiagnosticQuery(input: string): ValidatedQuery {
  const query = normalizeSingleQuery(input);
  const structuralQuery = maskQuoted(query);
  const upper = structuralQuery.toUpperCase();
  const startsWithSelect = /^SELECT\b/i.test(query);
  const startsWithWith = /^WITH\b/i.test(query);

  if (!startsWithSelect && !startsWithWith) {
    throw new Error(
      "diagnose_query accepts only SELECT or WITH ... SELECT queries."
    );
  }

  if (startsWithWith && findTopLevelKeyword(query, "SELECT") === -1) {
    throw new Error("WITH query must contain a top-level SELECT.");
  }

  for (const clause of ["INTO OUTFILE", "INTO DUMPFILE"]) {
    if (findTopLevelWords(query, clause) !== -1) {
      throw new Error(
        `Top-level ${clause} is not supported by diagnose_query.`
      );
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
    /^SETTINGS\s+[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(query.slice(settingsIndex))
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
