# Gozzle

A safety harness for your ClickHouse, inside your own AI.

Gozzle is a local developer toolkit for ClickHouse. The AI reasons; Gozzle runs checks and produces proof.

## Install

For early canary builds:

```bash
npm install -g @gozzle/cli@canary
```

Then print the MCP config snippet:

```bash
gozzle init
```

Add the printed config to Claude, Cursor, Codex, or another MCP host.

## Development

```bash
npm install
npm run build
npm test
```

## ClickHouse Connection

Gozzle reads ClickHouse connection details from environment variables:

```bash
GOZZLE_CLICKHOUSE_URL=http://localhost:8123
GOZZLE_CLICKHOUSE_USER=default
GOZZLE_CLICKHOUSE_PASSWORD=
GOZZLE_CLICKHOUSE_DATABASE=default
```

The `GOZZLE_` variables take precedence over the equivalent `CLICKHOUSE_` variables.
Use a read-only ClickHouse user; Gozzle does not need write access.

## Faithful Local Slices

> **Production data and retention warning:** local slices contain copied source
> rows and persist on disk until explicitly cleaned. Protect the slice directory,
> use an appropriate retention period, and do not treat a workspace as free of
> credentials or other sensitive values present in the source data or table DDL.

`create_local_slice` copies one complete ReplacingMergeTree-family partition to
a local chDB session through Parquet, replays a normalized local DDL, and reruns
the duplicate proof against both source and local data. Gozzle refuses partial
partitions because ClickHouse merges and deduplicates within partition scope.

If a table has multiple active partitions, pass the physical `partitionId`
reported by ClickHouse. Slices default to 100,000 rows and 256 MiB maximum and
are stored under `~/.gozzle/slices`:

```bash
GOZZLE_MAX_SLICE_ROWS=100000
GOZZLE_MAX_SLICE_BYTES=268435456
GOZZLE_MAX_TOTAL_SLICE_BYTES=2147483648
GOZZLE_SLICE_DIR=$HOME/.gozzle/slices
```

Each workspace contains `data.parquet`, a persistent chDB database, and a
`manifest.json`. Source and local proofs must match before Gozzle reports the
slice as verified. A mismatch usually means the source partition changed during
export; remove the workspace and recreate the slice. Replay disables chDB's
`optimize_on_insert` so ReplacingMergeTree duplicates remain visible for proof.

Gozzle measures the full recursive size of every slice workspace, including
Parquet and chDB files. Creation is refused when its projected storage would
exceed `GOZZLE_MAX_TOTAL_SLICE_BYTES` (2 GiB by default), and the completed
workspace is checked against the real aggregate before it is retained.

List and remove persisted slices without connecting to ClickHouse:

```bash
gozzle slices
gozzle slices clean slice-abc123
gozzle slices clean --all
gozzle slices clean --older-than 7d
gozzle slices clean --invalid
```

Listing reports valid, corrupt, and incomplete direct `slice-*` workspaces plus
their actual size and total storage. Normal cleanup removes valid workspaces.
Corrupt or incomplete workspaces require the explicit `--invalid` mode; cleanup
never traverses outside direct children of the configured slice directory.

## Migration Dry Runs

`dry_run_migration` accepts one `ALTER TABLE` statement and returns a verdict
without executing it on production. It distinguishes metadata-only changes,
part-rewriting mutations, risky materialized-column changes, and unsupported
operations.

For `ALTER ... UPDATE` and `ALTER ... DELETE`, Gozzle evaluates the predicate
read-only and joins matching `_part` values to `system.parts`. The result shows
both the matching row count and the complete compressed footprint of the parts
that ClickHouse may rewrite. Full-table operations use current table metadata
as a conservative upper bound.

The first implementation intentionally refuses compound ALTERs, `ON CLUSTER`,
partition operations, quoted table identifiers, mutation subqueries,
external-access table functions, and unfamiliar commands rather than inferring
an unsafe verdict. Audit logs store a hash of the statement, not its potentially
sensitive literals. Local chDB execution is deferred until supported ALTER
behavior is validated independently.

## Query Diagnosis

`diagnose_query` accepts one `SELECT` or `WITH ... SELECT` query and runs only
`EXPLAIN indexes = 1, projections = 1`. It never executes the original query.

Gozzle reports index conditions and selected/total parts and granules for each
MergeTree read. Full scans, absent partition pruning, and absent primary-key
granule pruning are marked as proven only when the EXPLAIN ratios support that
claim. `FINAL`, function-wrapped predicates, leading-wildcard searches, broad
joins, and `SELECT *` are reported separately as advisories.

The MVP rejects multiple statements, comments, output clauses, query-level
settings, external table functions, and non-SELECT statements. Audit logs and
tool output use a query fingerprint rather than echoing SQL literals. EXPLAIN
does not prove runtime duration, memory use, network transfer, join cardinality,
or the performance improvement from a suggested rewrite.

## Entry Points

- `gozzle`: CLI entrypoint.
- `gozzle-mcp`: MCP stdio server entrypoint.

## Canary Publishing

```bash
npm login
npm run build
npm test
npm publish --tag canary --access public
```

For later canaries:

```bash
npm version prerelease --preid canary
npm publish --tag canary --access public
```
