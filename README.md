# gozzle

Agent verification layer for ClickHouse changes.

Your AI changed ClickHouse SQL. gozzle proves what can be proven, checks what
can be checked, and clearly labels what remains uncertain.

## Install

```bash
npm install -g @gozzle/cli
```

Configure a read-only ClickHouse connection:

```bash
export GOZZLE_CLICKHOUSE_URL="https://example.clickhouse.cloud:8443"
export GOZZLE_CLICKHOUSE_USERNAME="readonly"
export GOZZLE_CLICKHOUSE_PASSWORD="..."
```

## First Check

Verify one SQL file:

```bash
gozzle verify ./queries/revenue.sql
```

Verify the files changed on your branch:

```bash
gozzle verify --changed
```

Prove a query rewrite returns the same rows:

```bash
gozzle verify --before ./old.sql --after ./new.sql
```

## What It Catches

gozzle currently verifies ClickHouse changes with bounded, read-only checks:

- Query plan regressions such as full scans and missing pruning.
- Query rewrites that change result shape or row multiset.
- ReplacingMergeTree duplicate reads that can silently overcount.
- Migration blast radius from active parts and compressed bytes.
- Migration cast, predicate, assignment, and default-expression failures against
  current data.

Every result carries evidence and limits. For example, a read-only migration
check can say “cast validated against current data,” but it will not claim lock
duration, merge timing, replication lag, or future data safety.

## CLI Surface

```bash
gozzle verify ./file.sql
gozzle verify --changed
gozzle verify --diff origin/main...HEAD
gozzle verify --all
gozzle verify --before old.sql --after new.sql
gozzle verify --json
gozzle verify --strict
```

Focused expert commands remain available:

```bash
gozzle equivalent old.sql new.sql
gozzle discover
gozzle init
gozzle skill
gozzle hook
gozzle slices
```

## MCP Surface

For agents, the primary tool is:

- `verify_artifact`: classify a query or migration, run the strongest safe
  verification plan, and return a verdict with evidence and limits.

Focused tools remain available when an agent needs deeper context:

- `diagnose_query`
- `verify_equivalent`
- `verify_dedup`
- `dry_run_migration`
- `inspect_table`
- `create_local_slice`

Run:

```bash
gozzle init
gozzle skill
```

to print MCP configuration and the agent instruction for Claude Code, Cursor, or
Codex.

## Read-only Guarantee

gozzle is not a query client and does not execute production writes. The
ClickHouse connection layer applies `readonly = 2` by default, plus execution,
result, row, and byte guardrails. Generated validation probes are SELECT-only.

Local slices are explicit and separate. They are used for deeper/offline checks,
not as the default correctness gate.

## Development

This repository is an npm workspaces monorepo.

| Path | Package | Description |
| --- | --- | --- |
| `packages/cli` | `@gozzle/cli` | CLI and MCP stdio server. |
| `apps/web` | `@gozzle/web` | Documentation site, built with Next.js and Fumadocs. |

```bash
npm install
npm run format:check
npm run lint
npm test
npm run build
npm run smoke:mcp -w @gozzle/cli
```

Useful package commands:

```bash
npm run build:cli
npm run build:web
npm run dev:web
```

`@gozzle/cli` is published as a canary on every push to `main` via
`.github/workflows/publish-canary.yml`.

## License

[Apache-2.0](LICENSE)
