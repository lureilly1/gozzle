# Gozzle Implementation Plan

Gozzle is a local safety harness and developer toolkit for ClickHouse. The initial product should stay narrow: help developers inspect risky ClickHouse behavior, verify common correctness problems, and de-risk migrations before production.

The guiding product line is:

> A safety harness for your ClickHouse, inside your own AI.

The practical implementation stance is:

> Gozzle is a ClickHouse developer toolkit that AI agents can use well. The AI reasons; Gozzle runs checks and produces proof.

The product boundary versus the official ClickHouse MCP is deliberate:

> The official ClickHouse MCP is a query gateway. Gozzle is a safety harness: it runs bounded checks and returns verdicts with proof.

## Current Progress

- Phase 1: complete.
- Phase 2: complete, including enforced read-only execution and query guardrails.
- Phase 3: complete.
- Phase 4: complete and verified against ClickHouse Cloud `SharedReplacingMergeTree`.
- Phase 5: complete for bounded, single-partition ReplacingMergeTree slices using chDB.
- Phase 5.1: complete.
- Phase 6: complete for read-only classification and affected-part estimates.
- Next user-facing tool: Phase 7, `diagnose_query`.

## Phase 0: Product Narrowing

Goal: lock the MVP around a small ClickHouse developer toolkit, not the full platform.

Deliverables:

- Final MVP tool list.
- Landing page copy aligned to "ClickHouse safety harness / developer toolkit".
- Clear non-goals: no generic SQL runner, no schema browser, no auto-fix-to-prod.
- First validation script for user interviews.

Initial MVP tools:

- `connect`
- `inspect_table`
- `verify_dedup`
- `dry_run_migration`
- `diagnose_query`

Defer:

- Materialized view replay.
- Full local slice automation.
- CI/watchdog.
- License enforcement.
- Rich UI panels.

Success criteria:

- The landing page and first demo describe a clear developer toolkit, not a generic AI database assistant.
- A ClickHouse developer can understand the first proof moment within 30 seconds.

## Phase 1: Project Scaffold

Goal: create the basic local MCP package.

Deliverables:

- TypeScript Node project.
- CLI entrypoint, likely `gozzle`.
- MCP server entrypoint, likely `gozzle-mcp`.
- Basic config loading.
- Structured logging.
- Test runner.
- Build/lint scripts.
- README with local setup.

Suggested package shape:

```text
src/
  cli.ts
  mcp/server.ts
  config/
  clickhouse/
  tools/
  checks/
  local-engine/
  shared/
tests/
fixtures/
```

Success criteria:

- `npm run build` works.
- MCP server starts over stdio.
- A dummy MCP tool can be called from a local test script.

## Phase 2: ClickHouse Connection Layer (Complete)

Goal: connect safely to a real ClickHouse cluster.

Deliverables:

- HTTP/native ClickHouse client wrapper.
- `connect` MCP tool.
- Connection config from environment variables or a local config file.
- Cloud vs self-hosted detection.
- Version detection.
- Basic permission inspection.
- Read-only enforcement for every query using `readonly=2`, independent of the configured account's grants.
- `GOZZLE_ENFORCE_READONLY` override for explicit local debugging.
- Per-query guardrails: `max_execution_time`, `max_result_rows`, and optional `max_rows_to_read` and `max_bytes_to_read`.
- Connection output reports active enforcement rather than stale account privilege warnings.

The product should aggressively communicate:

```text
Connected read-only.
No data leaves this machine.
```

Success criteria:

- Can connect to local or remote ClickHouse.
- Can run metadata queries.
- Fails clearly on bad credentials.
- Every query is forced read-only by default, even when the account has write privileges.
- Expensive or unexpectedly large model-initiated queries are bounded.

## Phase 3: Schema and Layout Inspection

Goal: understand ClickHouse physical behavior before trying to verify anything.

Deliverables:

- `inspect_table` tool.
- `SHOW CREATE TABLE` capture.
- Reads from `system.tables`, `system.columns`, and `system.parts`.
- Detection for:
  - table engine
  - `ORDER BY`
  - `PARTITION BY`
  - primary key
  - version/deleted columns for `ReplacingMergeTree`
  - row counts
  - active parts
  - partition distribution
  - distributed table wrappers

Success criteria:

- Given a table name, Gozzle can explain the physical layout.
- It can identify whether the table is a `ReplacingMergeTree`.
- It can tell whether the table is eligible for `verify_dedup`.

## Phase 4: First Hero Tool, `verify_dedup` (Complete)

Goal: produce the first proof moment.

Deliverables:

- `verify_dedup({ table, sampleLimit? })`.
- Detect duplicate exposure in `ReplacingMergeTree`-family tables.
- Count rows by `(_partition_id, sorting key)`, matching the scope within which ClickHouse merges and `FINAL` collapse rows.
- Return:
  - duplicate row count
  - affected key count
  - sample affected keys
  - a clear verdict with supporting evidence
- Refuse unsupported engines and direct Distributed tables to their underlying local tables.
- Record an audit entry for the check.

Initial implementation can run against production read-only first. The local slice can come later. That gives faster validation.

Example output:

```text
x 2.4M duplicate rows currently visible without FINAL

Table: events
Engine: ReplacingMergeTree(version)
Affected sorting keys: 184,203
Risk: dashboards querying without FINAL may overcount

Recommended:
Use FINAL for correctness-sensitive reads, or redesign the table/query path
if FINAL cost is unacceptable.
```

Success criteria:

- Finds real duplicate exposure on test fixtures.
- Produces a result a ClickHouse developer immediately understands.
- Refuses unsupported engines cleanly.
- Verified live against a ClickHouse Cloud `SharedReplacingMergeTree` table.

## Phase 5: Local Reproduction Substrate (Complete)

Goal: introduce the faithful local slice after the first tool has value.

Deliverables:

- Local engine abstraction with chDB as the first backend.
- Persistent local workspace management under `~/.gozzle/slices` by default.
- Normalized local ReplacingMergeTree DDL replay, including Shared and
  Replicated family engines.
- Streaming Parquet export/import path that does not buffer source rows in Node.
- Slice metadata manifest with source/local proof comparison; it may include
  sensitive table metadata and must be retained like the copied source data.
- `create_local_slice` MCP tool.
- Hard row and byte budgets controlled by `GOZZLE_MAX_SLICE_ROWS` and
  `GOZZLE_MAX_SLICE_BYTES`.
- Complete-partition requirement: Gozzle refuses partial data because merges
  and `FINAL` deduplicate within partition scope.
- chDB replay with `optimize_on_insert=0` so import does not erase duplicate
  evidence before verification.

Start narrow:

- Single table.
- `ReplacingMergeTree` family.
- One complete selected partition.
- Insertable source columns.
- 100,000 rows and 256 MiB by default.

Success criteria:

- Can copy a small slice locally.
- Can recreate table DDL locally.
- Can run the same duplicate check locally.
- Results match production for fixture datasets.
- Embedded chDB integration test proves Parquet replay preserves and detects
  ReplacingMergeTree duplicates.

Remaining beta validation:

- Run `create_local_slice` end to end against the existing ClickHouse Cloud
  `SharedReplacingMergeTree` fixture and confirm source/local proof parity.

## Phase 5.1: Slice Retention and Storage Safety

- Prominent production-data and retention warnings.
- Actual recursive workspace and aggregate storage reporting.
- Valid, corrupt, and incomplete workspace states in `gozzle slices list`.
- Age-based cleanup and explicit invalid-workspace cleanup.
- Aggregate storage cap through `GOZZLE_MAX_TOTAL_SLICE_BYTES`.
- Creation output with workspace path, total usage, and cleanup command.
- Clear concurrent-source-change guidance for proof mismatches.

## Phase 6: Migration Dry Run (Core Complete)

Goal: help developers catch dangerous `ALTER` statements before production.

Deliverables:

- `dry_run_migration({ statement })`; never executes the statement on production.
- Statement classification:
  - metadata-only
  - part-rewriting mutation
  - risky materialized column change
  - unsupported
- Affected rows/parts/bytes estimates from metadata.
- Predicate-scoped mutation estimates using matching `_part` values joined to
  `system.parts`, distinguishing matching rows from all rows in touched parts.
- Conservative full-table upper bounds for operations without a predicate.
- Statement fingerprints rather than raw migration literals in audit logs.
- Explicit unsupported verdicts for compound, clustered, partition, quoted
  identifier, and unfamiliar ALTER forms.

Example output:

```text
x This ALTER will rewrite existing parts

Statement:
ALTER TABLE events UPDATE user_id = ...

Estimated affected data:
842 parts
1.8 TB compressed
Likely long-running mutation
```

Success criteria:

- Identifies common expensive mutations.
- Explains why they are risky.
- Gives concrete affected size estimates.

Deferred Phase 6 extension:

- Optional execution against a disposable copy of a local slice, after each
  supported ALTER form is validated against chDB semantics.

## Phase 7: Query Diagnosis

Goal: broaden from correctness into developer toolkit territory.

Deliverables:

- `diagnose_query({ query })`.
- Uses `EXPLAIN indexes = 1`.
- Detects:
  - full table scans
  - missing partition pruning
  - missing primary key pruning
  - bad predicate shape
  - avoidable `FINAL`
  - expensive joins where obvious
- Returns candidate fixes as advice, not auto-applied changes.

Success criteria:

- Produces useful diagnosis on common slow query patterns.
- Separates verified findings from advisory findings.
- Avoids pretending to prove performance deltas before the fidelity spike.

## Phase 8: Test Harness and Fixtures

Goal: make the product trustworthy while developing quickly.

Deliverables:

- Docker-based ClickHouse test setup.
- Fixture DDLs:
  - clean `ReplacingMergeTree`
  - duplicate-exposed `ReplacingMergeTree`
  - partition split dedup case
  - distributed table advisory case
  - materialized view cases later
- Integration test script.
- Golden output tests for tool responses.

Success criteria:

- Tests can recreate known ClickHouse footguns.
- `verify_dedup` proves the expected issue.
- Regression tests protect output quality.

## Phase 9: Beta Packaging

Goal: make Gozzle installable by early users.

Deliverables:

- npm package.
- `gozzle init`.
- MCP config snippets for:
  - Claude Code
  - Cursor
  - Codex
- Beta docs.
- Minimal privacy page.
- Manual license gate or invite code, not full billing yet.

Success criteria:

- A beta user can install and run the first check in under 10 minutes.
- Setup failures can be observed through interviews, not telemetry.
- The product has a tight first-session proof path.

## Phase 10: Post-MVP Expansion

Only build these after real user feedback shows pull.

Candidates:

- `verify_materialized_view`.
- CI mode.
- Watchdog checks.
- Richer local slice engine.
- Performance `verify_fix`.
- Shell results page.
- License enforcement.
- Team/audit features.

The main rule: do not build the full platform until `verify_dedup`, migration risk, or query diagnosis clearly pulls users in.

## Open Product Questions

- Is the strongest wedge correctness, migration safety, or query diagnosis?
- Do developers want this in AI tools first, CI first, or both?
- Is the product valuable as a recurring toolkit, or does it feel like a one-time audit?
- Which ClickHouse engines and deployment shapes appear most often in early user conversations?
- How much local reproduction is needed before users trust the diagnosis?
