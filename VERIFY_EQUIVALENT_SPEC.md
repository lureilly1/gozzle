# Spec: `verify_equivalent`

Prove two SELECTs return the **same result** against real data — the
agent-refactor check ("you rewrote this query; is it actually equivalent?"). It
is the first check on the unified verdict contract: **exact-in-source, no
replica, no sampling**, so it validates the model without touching the hard
cases.

## Why it's exact and scalable

Equivalence is computed entirely inside the source engine in one statement: the
cluster diffs all N rows of both results and returns a count; gozzle transfers a
verdict plus a small capped sample of differing rows. No data is replicated.
Result equivalence = **same multiset of rows, order-independent** (a query's
`ORDER BY` is presentation, not identity).

## The comparison (one consistent snapshot)

Run both sides in a single query so they see the same data state:

```sql
SELECT
  countIf(_side = 'left')  AS left_only,
  countIf(_side = 'right') AS right_only
FROM (
  SELECT 'left'  AS _side FROM ( (<LEFT>) EXCEPT ALL (<RIGHT>) )
  UNION ALL
  SELECT 'right' AS _side FROM ( (<RIGHT>) EXCEPT ALL (<LEFT>) )
)
```

- `EXCEPT ALL` is multiset-aware, so it catches multiplicity differences (a row
  appearing 3× vs 2×), not just set differences. NULLs compare equal, which is
  what "same result" means.
- `left_only + right_only == 0` ⟺ equivalent. The split tells the user which side
  has the extra/missing rows.

When the count is non-zero, fetch a capped sample of the differing rows:

```sql
SELECT 'left' AS _side, * FROM ( (<LEFT>) EXCEPT ALL (<RIGHT>) ) LIMIT {n}
UNION ALL
SELECT 'right' AS _side, * FROM ( (<RIGHT>) EXCEPT ALL (<LEFT>) ) LIMIT {n}
```

## Shape check first (gives precise verdicts, avoids opaque EXCEPT errors)

Before the diff, compare result shapes with `DESCRIBE ( <LEFT> )` /
`DESCRIBE ( <RIGHT> )` (name + type, positional):

- **Column count or positional types differ** → `incorrect`, evidence = both
  shapes ("result shape differs: LEFT has … / RIGHT has …"). EXCEPT couldn't run
  anyway.
- **Types match, names differ** → still run the diff; if rows match, return
  `incorrect` with a "columns renamed (x→y); underlying rows identical" note. A
  rename is a real difference for downstream consumers, but we say so precisely.
- **Shapes match** → run the diff above.

(v1 aligns columns **positionally**; name-based realignment of reordered columns
is a later enhancement.)

## Verdict model (the new shared contract)

```typescript
type Verdict = "correct" | "incorrect" | "likely-correct" | "indeterminate";
type VerifyMethod = "exact-source" | "exact-replica" | "sampled";

interface VerifyEquivalentResult {
  check: "verify_equivalent";
  verdict: Verdict;            // correct | incorrect | indeterminate (never sampled here)
  method: "exact-source";
  differingRows: number;       // left_only + right_only; 0 when correct
  leftOnly: number;
  rightOnly: number;
  sample: Record<string, unknown>[];   // capped, tagged with _side
  shapeMismatch?: { left: ColumnShape[]; right: ColumnShape[] };
  indeterminateReason?: string;
}
```

- `correct` — shapes match and `differingRows == 0`. Exact; `method:
  exact-source`. (Note in the spirit of guardrail A: this is a true set
  operation, not a probabilistic checksum — so it earns `correct`.)
- `incorrect` — `differingRows > 0`, or a shape difference. Carries the sample /
  shape evidence.
- `indeterminate` — see below. Never a false `correct`.

`likely-correct`/`sampled` do not occur for this check; the type is shared so
later replica/sampled checks reuse it.

## When it returns `indeterminate` (honesty)

- **Non-determinism.** If either query (masked for string literals) uses a
  non-deterministic function — `rand*`, `now`/`now64`, `today`/`yesterday`,
  `generateUUID*`, `randConstant` — equivalence is undefined (each side evaluates
  its own). Return `indeterminate`: "query is non-deterministic (uses `rand`);
  equivalence cannot be proven." This is detected, not executed-around.
- **Too large for the scan guard.** The diff is ~two full scans per side. If
  ClickHouse aborts on `max_execution_time` / read limits, catch it →
  `indeterminate`: "queries are too large to compare exactly — add a matching
  filter to both, or compare over a single partition." (We can't auto-scope
  opaque SELECTs.)
- **`LIMIT` without a total order** is flagged as a warning (the returned
  multiset is itself order-dependent), but still compared; the verdict notes it.

## Validation & safety

Each side is validated with the existing `validateDiagnosticQuery`
(`query-validator.ts`): `SELECT`/`WITH … SELECT` only, single statement, no
comments, no external table functions, no top-level `FORMAT`/`INTO`/`SETTINGS`.
Everything runs under `readonly=2` + guardrails. The original queries are never
mutated; only wrapped in the diff above. Audit logs store fingerprints of both
queries, not the SQL.

## Surfaces

- **MCP tool `verify_equivalent({ left, right, sampleLimit? })`** — the primary
  surface (the agent has both the old and rewritten query). Returns prose +
  `structuredContent` (`verdict`, `method`, `differingRows`, `leftOnly`,
  `rightOnly`, `sample`).
- **CLI `gozzle equivalent <a.sql> <b.sql> [--json]`** — strips comments, runs
  the check, prints the verdict + a divergent-row sample. Exit codes: `0`
  correct · `1` incorrect · `2` indeterminate/error (so CI surfaces it).

## Files

- **New** `src/shared/verdict.ts` — shared `Verdict` / `VerifyMethod` /
  `Coverage` types (the contract other checks migrate onto).
- **New** `src/clickhouse/equivalent.ts` — `verifyEquivalent(client, { left,
  right, sampleLimit, defaultDatabase })`: validate both, DESCRIBE shapes,
  non-determinism guard, run the diff + sample, build the result.
- **New** `src/tools/verify-equivalent.ts` — MCP tool, formatter, structured
  builder (mirrors the existing tools).
- **New** `src/commands/equivalent.ts` — `runEquivalentCommand` (two file args).
- **Edit** `src/mcp/server.ts` (register tool), `src/cli.ts` (`equivalent`
  command + help).
- **Reuse:** `validateDiagnosticQuery`, `ClickHouseHttpMetadataClient`,
  `stripSqlComments`, `recordAudit`, `formatCount`.

## Tests (fake client)

- `correct`: shapes match, diff query returns `{left_only:0, right_only:0}`.
- `incorrect` by data: diff returns non-zero; sample returned and tagged.
- `incorrect` by shape: DESCRIBE rows differ → shapeMismatch, no diff query run.
- `incorrect` by rename: same types, different names, diff 0 → note present.
- `indeterminate` non-deterministic: `left = SELECT rand()` → no diff query runs.
- `indeterminate` on aborts: client throws a `max_execution_time` error → mapped.
- Validation: a non-SELECT side is rejected.
- CLI: arg parsing (two files required), exit-code mapping, missing file → 2.
- Structured builder: verdict/method/fields mapping.

## End-to-end verification (when a cluster is reachable)

```bash
gozzle equivalent ./old.sql ./new.sql        # expect: correct, exit 0
# tweak new.sql to drop a GROUP BY key → expect: incorrect + sample, exit 1
```

## What this establishes

- The shared `verdict/method/coverage` contract and report shape, ready for the
  other checks to adopt.
- A second exact-in-source check proving the "push the comparison to the source"
  model — no replica, scales to any size (subject to the scan guard), degrades to
  honest `indeterminate`.
