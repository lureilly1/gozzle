# Changelog

All notable changes to `@gozzle/cli` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.

## [Unreleased]

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
