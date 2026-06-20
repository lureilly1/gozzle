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
GOZZLE_SLICE_DIR=$HOME/.gozzle/slices
```

Each workspace contains `data.parquet`, a persistent chDB database, and a
credential-free `manifest.json`. Source and local proofs must match before
Gozzle reports the slice as verified. Replay disables chDB's
`optimize_on_insert` so ReplacingMergeTree duplicates remain visible for proof.

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
