# gozzle Quality & Hardening Plan

Follow-on from the codebase review. Scope: make the existing tools trustworthy on
real production tables before beta. P0 items are the focus; P1/P2 are the backlog.

The architecture is sound — these are targeted reliability fixes, not a rewrite.

## P0 — before beta

### P0.1 `verify_dedup` must survive large tables

**Problem.** The hero tool runs up to three near-full scans of the table when no
`partitionId` is given (`src/clickhouse/dedup.ts`):

1. the group-by aggregate (`duplicate_groups`/`duplicate_rows`/`max_copies`),
2. a global `count() - uniqExact(sortingKey)` for `finalCollapsibleRows`,
3. the sample query.

On a multi-TB ReplacingMergeTree — exactly where duplicates matter — this blows
the default `max_execution_time = 30` (`config/guardrails.ts`) and `uniqExact` is
memory-hungry. The tool is most likely to fail on the tables that most need it.

**Changes.**

1. **Skip the redundant scan when unpartitioned.** When `inspection.partitionBy`
   is absent there is a single partition, so `finalCollapsibleRows ===
   duplicateRows`. Set it from the first aggregate and do **not** run the global
   `uniqExact` query. Removes one full scan + the memory-heavy aggregate in the
   common case. (Correctness-preserving; the multi-partition path is unchanged.)

2. **Pre-flight size guard.** `verifyDedup` already inspects the table first. If
   `totalRows`/`totalBytes` exceed configurable thresholds and no `partitionId`
   was supplied, return an **actionable verdict** instead of attempting a doomed
   scan: list the largest partitions (already available via the partition read in
   `slice.ts:readPartitions`) and recommend scoping to a partition or creating a
   local slice. New env: `GOZZLE_DEDUP_MAX_SCAN_ROWS` (default e.g. 200_000_000),
   `GOZZLE_DEDUP_MAX_SCAN_BYTES`. Setting `0` disables the guard.

3. **Timeout-aware error.** Wrap the dedup queries; when ClickHouse aborts with a
   `max_execution_time` / read-limit error, catch it in `tools/verify-dedup.ts`
   and return a clear message ("table too large to prove in one pass — scope to a
   partition with `partitionId`, or create a local slice"), not the raw server
   error.

4. **(Stretch) Approximate fast mode.** Optional `approximate` flag using `uniq()`
   instead of `uniqExact()`, clearly labelled in the verdict as an estimate. Only
   if interviews show users want a fast over-large-table signal.

**Files.** `src/clickhouse/dedup.ts`, `src/tools/verify-dedup.ts`,
`src/config/guardrails.ts` (or a small new config), partition helper reused from
`src/local-engine/slice.ts`.

**Acceptance.**
- Unpartitioned table: only the group-by (+ sample) runs; no `uniqExact` query.
- Table over threshold with no `partitionId`: returns a scope/slice verdict
  without attempting the full scan, including the largest partition ids.
- A query aborted by `max_execution_time` yields the actionable message, not a
  stack trace.
- New unit tests with a fake `ClickHouseMetadataClient` asserting which queries
  run per branch; existing `dedup.test.ts` and `chdb-local-engine.test.ts` pass.

### P0.2 Derive `partitionBy` from `system.tables`, not `SHOW CREATE`

**Problem.** `inspectTable` fetches `partition_key` from `system.tables` but then
sets `partitionBy` by string-scanning the `SHOW CREATE` text via `extractClause`
(`src/clickhouse/table-inspection.ts`). DDL string parsing is fragile (comments,
nested/function expressions) and the canonical value is already in hand.

**Changes.**
- Use `table.partition_key` for `partitionBy` (fall back to `extractClause` only
  if the column is empty). Consider the same for `orderBy` display, keeping
  `sortingKey` from `system.tables.sorting_key` as today.
- Keep `extractClause` only as a fallback; add a comment that `system.tables` is
  canonical.

**Files.** `src/clickhouse/table-inspection.ts`.

**Acceptance.**
- `partitionBy` reflects `system.tables.partition_key`.
- New test: a table with `PARTITION BY toYYYYMM(ts)` and a column comment
  containing the text "PARTITION BY" resolves correctly.
- Downstream `buildLocalCreateStatement` (slice) and dedup partition logic
  unaffected; existing tests pass.

## P1 — soon after beta opens

- **Structured tool output.** Return MCP `structuredContent` (verdict, counts,
  eligibility, finding codes) alongside the prose so agents act on data, not
  parsed text. Start with `verify_dedup` and `dry_run_migration`.
- **chDB fidelity signal.** Record chDB's `version()` in the slice manifest
  (`src/local-engine/slice.ts`) and compare to the source server version; warn on
  divergence. Soften the "faithful slice" wording where DDL is reconstructed.
- **Server integration coverage.** Extend the integration job (currently
  guardrails only) to `verify_dedup`, `diagnose_query`, and `dry_run_migration`
  against a real server, asserting verdicts/invariants (not exact EXPLAIN text).

## P2 — hardening backlog

- **Adversarial SQL tests** for the hand-rolled scanners in
  `query-validator.ts` and `migration-parser.ts`; consider chDB/`clickhouse-local`
  -backed validation as defense-in-depth in tests (keep runtime parsers portable).
- **Distributed tables:** resolve underlying local table / shard topology instead
  of only refusing.
- **EXPLAIN format drift:** snapshot EXPLAIN parsing (`explain.ts`) across a
  couple of ClickHouse versions in CI.
- **Platform docs:** state local slices need linux/macOS (Windows via WSL).

## Sequencing

P0.1 and P0.2 are independent and small; do both before recruiting beta users,
since P0.1 governs the first-impression tool. P1 follows once real tables are in
play. P2 is opportunistic.
