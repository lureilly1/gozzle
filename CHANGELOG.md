# Changelog

All notable changes to `@gozzle/cli` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.

## [Unreleased]

### Fixed

- Migration cast probes no longer fail on `LowCardinality(...)` or
  `Nullable(...)` target types: the probe casts to the inner type, so
  `MODIFY COLUMN status LowCardinality(String)` validates instead of erroring
  (`accurateCastOrNull` rejects types that cannot sit inside Nullable). Targets
  that cannot be probed at all (Array, Tuple, Map, ...) now report an honest
  `unknown` instead of a false error.
- The ClickHouse client no longer prints its own error log to stderr when a
  probe query fails; gozzle reports the failure itself.

### Changed

- A proven full scan only blocks the verify gate for large tables (>= 10M rows
  or >= 1 GiB); on smaller tables it is reported as a non-blocking warning,
  since whole-table aggregates there are usually intentional. Table size is now
  included in the finding's evidence.
- The read-path proof refuses to bind a `unique_by` assumption to a table whose
  sorting key differs, and says how to fix the assumption, instead of reporting
  sorting-key duplicates as a violation of the declared columns.
- `verify_equivalent` returns `indeterminate` for queries whose row set is
  unstable across evaluations: a top-level `LIMIT` without `ORDER BY`, or a
  `SAMPLE` clause.

## [0.1.6]

### Added

- Planner-led verification engine: artifacts are classified, the strongest safe
  check is selected, and every result returns a unified verdict contract
  (`VerificationRun`) with verdict, confidence/evidence level, strategy,
  coverage, findings, and limits.
- `verify_artifact` MCP tool: classify a ClickHouse query or migration and run
  the planner from a single entry point. Focused tools remain for deeper context.
- `gozzle verify --before <a.sql> --after <b.sql>`: route a query rewrite through
  the planner as a before/after equivalence check.
- `gozzle verify --diff <range> --format github`: Markdown report with a verdict,
  per-file table, findings, and limits for CI.
- `verify_equivalent` tool / `gozzle equivalent <a.sql> <b.sql>`: prove two
  SELECTs return the same result, entirely inside the source engine.
- PostToolUse hook (`gozzle hook`) to auto-verify ClickHouse `.sql` changes.
- `dry_run_migration` read-only correctness gate for mutation predicates, UPDATE
  assignment expressions, MODIFY COLUMN casts, and DEFAULT/MATERIALIZED column
  expressions against current ClickHouse data.
- Docs: verification-planner, claims-and-limits, and CI pages.

### Changed

- `gozzle verify --json` now emits the `VerificationRun` contract; MCP structured
  output exposes the same contract across tools.
- Agent skill now instructs agents to call `verify_artifact` first and reach for
  focused tools only when more context is needed.
- Internal: consolidated shared helpers, split the verify command into focused
  modules, unified the ClickHouse client lifecycle, and added ESLint/Prettier.
- License changed to Apache-2.0.

### Fixed

- `gozzle discover` now filters to user queries and drops platform/system noise.

## [0.1.5]

Baseline release on npm. See the git history for details.

[Unreleased]: https://github.com/lureilly1/gozzle/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/lureilly1/gozzle/releases/tag/v0.1.6
[0.1.5]: https://github.com/lureilly1/gozzle/releases/tag/v0.1.5
