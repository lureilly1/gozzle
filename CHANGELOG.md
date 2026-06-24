# Changelog

All notable changes to `@gozzle/cli` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.

## [Unreleased]

### Added

- `verify_equivalent` tool / `gozzle equivalent <a.sql> <b.sql>`: prove two
  SELECTs return the same result, entirely inside the source engine.
- PostToolUse hook (`gozzle hook`) to auto-verify ClickHouse `.sql` changes.

### Fixed

- `gozzle discover` now filters to user queries and drops platform/system noise.

### Changed

- Internal: consolidated shared helpers, split the verify command into focused
  modules, unified the ClickHouse client lifecycle, and added ESLint/Prettier.
- License changed to Apache-2.0.

## [0.1.5]

Baseline release on npm. See the git history for details.

[Unreleased]: https://github.com/lureilly1/gozzle/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/lureilly1/gozzle/releases/tag/v0.1.5
