# Gozzle Implementation Plan

Gozzle is a local safety harness and developer toolkit for ClickHouse. The initial product should stay narrow: help developers inspect risky ClickHouse behavior, verify common correctness problems, and de-risk migrations before production.

The guiding product line is:

> A safety harness for your ClickHouse, inside your own AI.

The practical implementation stance is:

> Gozzle is a ClickHouse developer toolkit that AI agents can use well. The AI reasons; Gozzle runs checks and produces proof.

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

## Phase 2: ClickHouse Connection Layer

Goal: connect safely to a real ClickHouse cluster.

Deliverables:

- HTTP/native ClickHouse client wrapper.
- `connect` MCP tool.
- Connection config from environment variables or a local config file.
- Cloud vs self-hosted detection.
- Version detection.
- Basic permission inspection.
- Read-only guardrail warnings.

The product should aggressively communicate:

```text
Connected read-only.
No data leaves this machine.
```

Success criteria:

- Can connect to local or remote ClickHouse.
- Can run metadata queries.
- Fails clearly on bad credentials.
- Warns if the user appears to have unnecessary write privileges.

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

## Phase 4: First Hero Tool, `verify_dedup`

Goal: produce the first proof moment.

Deliverables:

- `verify_dedup({ table, query? })`.
- Detect duplicate exposure in `ReplacingMergeTree` tables.
- Compare current results against `FINAL` semantics.
- Return:
  - duplicate row count
  - affected key count
  - sample affected keys
  - whether duplicates cross partitions
  - whether distributed topology makes the result advisory
  - suggested next query pattern

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

## Phase 5: Local Reproduction Substrate

Goal: introduce the faithful local slice after the first tool has value.

Deliverables:

- Local engine abstraction.
- First backend: `clickhouse-local` or chDB.
- Temporary local workspace management.
- DDL replay locally.
- Parquet export/import path.
- Slice metadata manifest.

Start narrow:

- Single table.
- `ReplacingMergeTree`.
- Selected partitions.
- Limited column set.
- Size budget.

Success criteria:

- Can copy a small slice locally.
- Can recreate table DDL locally.
- Can run the same duplicate check locally.
- Results match production for fixture datasets.

## Phase 6: Migration Dry Run

Goal: help developers catch dangerous `ALTER` statements before production.

Deliverables:

- `dry_run_migration({ statement })`.
- Statement classification:
  - metadata-only
  - part-rewriting mutation
  - risky materialized column change
  - unsupported
- Affected rows/parts/bytes estimates from metadata.
- Optional execution against the local slice where possible.

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
