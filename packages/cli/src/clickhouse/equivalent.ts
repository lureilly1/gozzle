import type { ClickHouseMetadataClient } from "./client.js";
import { toNumber } from "../shared/num.js";
import { isResourceLimitError } from "../shared/errors.js";
import { validateDiagnosticQuery } from "./query-validator.js";
import { findTopLevelKeyword, maskQuoted } from "./sql-scan.js";
import type { EquivalenceVerdict } from "../shared/verdict.js";

export interface ColumnShape {
  name: string;
  type: string;
}

export interface VerifyEquivalentOptions {
  left: string;
  right: string;
  sampleLimit?: number;
}

export interface VerifyEquivalentResult {
  check: "verify_equivalent";
  verdict: EquivalenceVerdict;
  method: "exact-source";
  differingRows: number;
  leftOnly: number;
  rightOnly: number;
  /** Capped sample of rows present on only one side, tagged with `_side`. */
  sample: Record<string, unknown>[];
  /** Set when result shapes (column count / positional types) differ. */
  shapeMismatch?: { left: ColumnShape[]; right: ColumnShape[] };
  /** True when rows are identical but column names differ. */
  renamed?: boolean;
  indeterminateReason?: string;
}

const DEFAULT_SAMPLE_LIMIT = 10;

/**
 * Prove whether two SELECTs return the same result, exactly and entirely inside
 * the source engine (no data is replicated). Equivalence = same multiset of
 * rows, order-independent.
 */
export async function verifyEquivalent(
  client: ClickHouseMetadataClient,
  options: VerifyEquivalentOptions
): Promise<VerifyEquivalentResult> {
  const left = validateDiagnosticQuery(options.left).query;
  const right = validateDiagnosticQuery(options.right).query;
  const sampleLimit = clampSampleLimit(options.sampleLimit);

  const base = {
    check: "verify_equivalent" as const,
    method: "exact-source" as const,
    differingRows: 0,
    leftOnly: 0,
    rightOnly: 0,
    sample: [] as Record<string, unknown>[]
  };

  const nonDeterministic =
    firstNonDeterministic(left) ?? firstNonDeterministic(right);
  if (nonDeterministic) {
    return {
      ...base,
      verdict: "indeterminate",
      indeterminateReason: `Query is non-deterministic (uses ${nonDeterministic}); equivalence cannot be proven.`
    };
  }

  const unstable = firstUnstableRowSet(left) ?? firstUnstableRowSet(right);
  if (unstable) {
    return {
      ...base,
      verdict: "indeterminate",
      indeterminateReason: `Query ${unstable}, so its row set is not stable and equivalence cannot be proven.`
    };
  }

  const [leftShape, rightShape] = await Promise.all([
    describeShape(client, left),
    describeShape(client, right)
  ]);

  const typesMatch =
    leftShape.length === rightShape.length &&
    leftShape.every((column, i) => column.type === rightShape[i].type);
  if (!typesMatch) {
    return {
      ...base,
      verdict: "incorrect",
      shapeMismatch: { left: leftShape, right: rightShape }
    };
  }
  const namesMatch = leftShape.every(
    (column, i) => column.name === rightShape[i].name
  );

  let leftOnly: number;
  let rightOnly: number;
  try {
    const [row] = await client.queryJson<{
      left_only: string | number;
      right_only: string | number;
    }>(diffQuery(left, right));
    leftOnly = toNumber(row?.left_only ?? 0);
    rightOnly = toNumber(row?.right_only ?? 0);
  } catch (error) {
    if (isResourceLimitError(error)) {
      return {
        ...base,
        verdict: "indeterminate",
        indeterminateReason:
          "Queries are too large to compare exactly. Add a matching filter to both, or compare over a single partition."
      };
    }
    throw error;
  }

  const differingRows = leftOnly + rightOnly;

  if (differingRows === 0) {
    return namesMatch
      ? { ...base, verdict: "correct" }
      : { ...base, verdict: "incorrect", renamed: true };
  }

  const sample = await client.queryJson<Record<string, unknown>>(
    sampleQuery(left, right, sampleLimit)
  );
  return {
    ...base,
    verdict: "incorrect",
    differingRows,
    leftOnly,
    rightOnly,
    sample,
    renamed: !namesMatch
  };
}

async function describeShape(
  client: ClickHouseMetadataClient,
  query: string
): Promise<ColumnShape[]> {
  const rows = await client.queryJson<{ name: string; type: string }>(
    `DESCRIBE ( ${query} )`
  );
  return rows.map((row) => ({ name: row.name, type: row.type }));
}

function diffQuery(left: string, right: string): string {
  return `
    SELECT
      countIf(_side = 'left') AS left_only,
      countIf(_side = 'right') AS right_only
    FROM (
      SELECT 'left' AS _side FROM ( (${left}) EXCEPT ALL (${right}) )
      UNION ALL
      SELECT 'right' AS _side FROM ( (${right}) EXCEPT ALL (${left}) )
    )`;
}

function sampleQuery(left: string, right: string, limit: number): string {
  return `
    SELECT 'left' AS _side, * FROM ( (${left}) EXCEPT ALL (${right}) ) LIMIT ${limit}
    UNION ALL
    SELECT 'right' AS _side, * FROM ( (${right}) EXCEPT ALL (${left}) ) LIMIT ${limit}`;
}

// Non-deterministic functions make equivalence undefined (each side evaluates
// its own). Mask single-quoted literals first so values like 'random' don't
// trigger a false positive.
const NON_DETERMINISTIC =
  /\b(rand[A-Za-z0-9]*|now64|now|today|yesterday|generateUUID[A-Za-z0-9]*)\s*\(/i;

function firstNonDeterministic(query: string): string | undefined {
  const masked = query.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
  const match = masked.match(NON_DETERMINISTIC);
  return match ? match[1] : undefined;
}

/**
 * Constructs that make the row multiset itself unstable across evaluations:
 * a top-level LIMIT without ORDER BY picks arbitrary rows, and SAMPLE reads a
 * nondeterministic subset. Each side of the comparison evaluates independently,
 * so an unstable row set cannot be proven equivalent to anything.
 */
function firstUnstableRowSet(query: string): string | undefined {
  if (
    findTopLevelKeyword(query, "LIMIT") !== -1 &&
    findTopLevelKeyword(query, "ORDER") === -1
  ) {
    return "uses LIMIT without a top-level ORDER BY";
  }
  if (/\bSAMPLE\s+[\d.]/i.test(maskQuoted(query))) {
    return "uses a SAMPLE clause";
  }
  return undefined;
}

function clampSampleLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_SAMPLE_LIMIT;
  }
  return Math.min(Math.floor(value), 50);
}
