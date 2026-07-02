# gozzle

**The verification layer between AI-written SQL and your ClickHouse.**

Your agent (or your teammate's agent) just rewrote a query or produced a
migration. It looks right. gozzle proves what can be proven about it — against
your real cluster, without executing a single write — and clearly labels what
remains uncertain.

```
▸ old.sql...new.sql  (QUERY PAIR)
Verdict: FAIL
Confidence: exact
Checks: query_equivalence

Findings:
- [error] query_not_equivalent: Exact comparison found 100 differing row(s).
```

That is a real catch: a rewrite that swapped `>=` for `>` and silently dropped a
day of data. Linters can't see it. An agent's self-review didn't see it. Running
both queries against the actual data did.

## Why this exists

Agents write plausible SQL with total confidence, and ClickHouse has sharp
edges that plausible SQL walks straight into:

- A `ReplacingMergeTree` read without `FINAL` silently overcounts until a merge
  happens to run.
- A "harmless" `ALTER TABLE ... UPDATE` casts a column and NULLs 500 rows into a
  non-Nullable target — a failure you find out about mid-mutation.
- A rewritten query returns a different row set for exactly one edge case.
- A refactored filter stops pruning partitions and turns a 50 ms query into a
  full scan.

gozzle is not a linter and not an agent-observability tool. It is
**execution-verified correctness**: it runs bounded, read-only checks against
current data and returns a verdict backed by evidence.

## Install

```bash
npm install -g @gozzle/cli
```

Requires Node 22+. Tested against ClickHouse 24.8 and newer (CI runs 24.8; the
checks use `EXCEPT ALL`, `EXPLAIN indexes = 1, projections = 1`, and
`accurateCastOrNull`, so recent 23.x may work but is not verified).

Point it at your cluster with a **read-only** account:

```bash
export GOZZLE_CLICKHOUSE_URL="https://your-instance.clickhouse.cloud:8443"
export GOZZLE_CLICKHOUSE_USER="readonly"
export GOZZLE_CLICKHOUSE_PASSWORD="..."
export GOZZLE_CLICKHOUSE_DATABASE="analytics"   # optional default database
```

Bare `CLICKHOUSE_*` variables work too; `GOZZLE_*` wins when both are set.

## First check

Verify one SQL file (a `SELECT` query or an `ALTER` migration — gozzle
classifies it):

```bash
gozzle verify ./queries/revenue.sql
```

Prove a rewrite returns the same rows:

```bash
gozzle verify --before old.sql --after new.sql
```

Verify what changed on your branch (each changed query is compared against its
git base version as a before/after pair):

```bash
gozzle verify --changed
gozzle verify --diff origin/main...HEAD
```

Exit codes are CI-ready: `0` pass, `1` a check failed the gate, `2` gozzle
could not verify (connection, unsupported file, ...). Add `--strict` to also
fail on warnings, `--json` for the machine-readable contract, or
`--format github` for a Markdown PR comment.

## What it checks

| Check | Question it answers | Evidence |
| --- | --- | --- |
| Query equivalence | Do two SELECTs return the same multiset of rows? | Exact: `EXCEPT ALL` both ways, computed inside ClickHouse, plus a capped sample of divergent rows |
| Read-path proof | Does this query trust a uniqueness the data violates? | Exact: duplicate scan by sorting key on tables you declare unique (see `gozzle.yaml` below) |
| Dedup state | Does this `ReplacingMergeTree` currently hold duplicates, and what would `FINAL` collapse? | Exact: distinguishes duplicates merges will remove from cross-partition ones they never will |
| Query plan | Does this query scan everything / skip partition and primary-key pruning? | `EXPLAIN indexes=1` evidence with the table's actual `ORDER BY`/`PARTITION BY` in the recommendation |
| Migration blast radius | How many parts, rows, and bytes does this ALTER touch? | Metadata + a predicate-matched part scan |
| Migration correctness | Do the casts, expressions, and predicates hold on current data? | Read-only probes (e.g. `accurateCastOrNull`) over every affected row — catches the 500 NULLs *before* the mutation runs |

Full scans are reported on every table but only block the gate for large tables
(≥ 10M rows or ≥ 1 GiB) — a whole-table aggregate on a small table is usually
the intent.

Every result carries its confidence (`exact`, `bounded`, `explain`, `metadata`,
`advisory`) and its limits. gozzle will tell you "cast validated against current
data" — it will not pretend to know lock duration, replication lag, or whether
tomorrow's inserts stay clean.

## The read-only guarantee

gozzle never executes your artifact against production. Every connection pins
`readonly = 2` at the session level, so ClickHouse itself rejects any write or
DDL — this is enforced by the server, not by parsing, and covered by
integration tests against a real server with a write-capable account.

On top of that:

- Every statement gozzle generates is a SELECT (or `EXPLAIN`/`DESCRIBE`/`SHOW CREATE`).
- Inputs are validated: one statement, no comments, no `INTO OUTFILE`, and
  external-access table functions (`url`, `s3`, `remote`, ...) are rejected, so
  a malicious artifact can't exfiltrate data through a verification read.
- Cost guardrails by default: 30 s `max_execution_time` and 10k
  `max_result_rows` per query. Optional caps on rows/bytes read
  (`GOZZLE_MAX_ROWS_TO_READ`, `GOZZLE_MAX_BYTES_TO_READ`) are off by default;
  set them if your cluster is busy. Oversized exact checks return
  `indeterminate` with a "scope to partition X" suggestion instead of grinding.

## `gozzle.yaml` — declare what your queries assume

Drop a `gozzle.yaml` at the repo root:

```yaml
database: analytics

queries:
  - queries/**/*.sql
migrations:
  - migrations/**/*.sql

assumptions:
  analytics.orders:
    unique_by: [user_id, order_id]
```

The globs power `gozzle verify --all` and file selection for `--changed`. The
`assumptions` power the read-path proof: any verified query that reads
`analytics.orders` without `FINAL` gets a live duplicate check, so "duplicates
exist" becomes "**this query** can overcount":

```
Read-path proof:
- [error] analytics.orders is read without FINAL and trusted as unique by
  (user_id, order_id), but currently has 500 duplicate row(s) by sorting key.
  This query can overcount.
```

`unique_by` must match the table's `ORDER BY` (sorting key) — that is the key
ReplacingMergeTree deduplicates by, and gozzle refuses to bind a claim to a key
it can't prove.

## For agents (MCP)

gozzle ships an MCP stdio server (`gozzle-mcp`). Print ready-to-paste
configuration and an agent instruction for Claude Code, Cursor, or Codex:

```bash
gozzle init          # MCP server config
gozzle skill         # the "verify before done" agent instruction
gozzle hook          # PostToolUse hook: auto-verify .sql files the agent edits
```

The primary tool is **`verify_artifact`**: hand it a query or migration, gozzle
classifies it, runs the strongest safe plan, and returns the verdict contract
(verdict, confidence, findings, evidence, limits). Focused tools remain for
deeper context: `diagnose_query`, `verify_equivalent`, `verify_dedup`,
`dry_run_migration`, `inspect_table`, `create_local_slice`, `connect`, `health`.

The hook is the deterministic path: agents sometimes forget to verify; a
PostToolUse hook doesn't.

## In CI

```yaml
- name: Verify ClickHouse changes
  run: gozzle verify --diff origin/main...HEAD --format github >> "$GITHUB_STEP_SUMMARY"
  env:
    GOZZLE_CLICKHOUSE_URL: ${{ secrets.CLICKHOUSE_URL }}
    GOZZLE_CLICKHOUSE_USER: readonly
    GOZZLE_CLICKHOUSE_PASSWORD: ${{ secrets.CLICKHOUSE_READONLY_PASSWORD }}
```

Point CI at a read-only user on production (the checks are bounded and
read-only) or at a staging replica with representative data.

## Local slices (optional, deeper checks)

`create_local_slice` / `gozzle slices` can replicate a single partition of a
`ReplacingMergeTree` into a local [chDB](https://github.com/chdb-io/chdb) engine
for offline reproduction. Slices are explicit, size-capped, stored under
`~/.gozzle`, and cleaned with `gozzle slices clean`. They are a reproduction
tool — the default correctness checks all run exact-in-source against your
cluster and never replicate data.

chDB is an optional native dependency (linux/macOS, x86_64/arm64); everything
else works without it.

## What gozzle is not

- **Not a linter.** It doesn't opine on style; it executes checks against data.
- **Not agent observability.** It verifies the SQL produced, not the agent that
  produced it.
- **Not a migration runner.** It proves what an ALTER would do; you run it with
  your own tooling.
- **Not magic.** Checks that would require executing the migration are labeled
  with exactly what was and wasn't proven. `correct` only ever comes from an
  exact method.

## Development

npm workspaces monorepo:

| Path | Package | Description |
| --- | --- | --- |
| `packages/cli` | `@gozzle/cli` | CLI and MCP stdio server. |
| `apps/web` | `@gozzle/web` | Documentation site (Next.js + Fumadocs). |

```bash
npm install
npm run lint
npm test                                  # unit tests (fast, no server)
npm run build
npm run smoke:mcp -w @gozzle/cli          # MCP protocol smoke test
npm run test:integration -w @gozzle/cli   # needs a real ClickHouse; see tests/integration
```

A hands-on tour against a throwaway ClickHouse lives in
[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md).

`@gozzle/cli` is published as a canary on every push to `main`.

## License

[Apache-2.0](LICENSE)
