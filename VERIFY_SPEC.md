# Spec: `gozzle verify <file>`

The foundational verb of the change-harness direction: verify a ClickHouse SQL
or migration **file** against the real cluster, read-only, and exit non-zero on
findings so it drops into any CI. `--changed` / `--diff` and the agent skill all
build on this atom. Free / local.

## Command surface (v1)

```bash
gozzle verify <file> [<file> ...]     # verify one or more .sql files
gozzle verify <file> --strict         # also fail on advisory findings
gozzle verify <file> --json           # machine-readable output (optional, see below)
```

- Accepts one or more file paths. Each file is expected to contain **one**
  statement (a `SELECT`/`WITH … SELECT`, or one `ALTER TABLE`).
- Connection comes from the existing env config (`readClickHouseConfig`,
  `GOZZLE_/CLICKHOUSE_*`). **No `gozzle.yaml` required for v1** — that arrives
  later for profiles, globs, and assumptions.
- Out of scope for v1: inline `--query "<sql>"`, multi-statement files, dbt/jinja
  templating (`{{ }}`), and the read-path/dedup proof (needs `gozzle.yaml`
  assumptions — separate spec).

## Behaviour

1. **Read** each file. **Strip SQL comments** (`--` line and `/* */` block,
   ignoring comment markers inside string/identifier literals) as a preprocessing
   step, then trim and drop a single trailing `;`. Comment stripping is required
   because real `.sql` files have header comments, and the existing validators
   reject comments outright.
2. **Detect statement type** from the leading keyword of the cleaned statement:
   - `SELECT` / `WITH` → query path
   - `ALTER` → migration path
   - anything else → operational error for that file (exit 2), clear message.
3. **Route to the existing engine** (no new verification logic):
   - Query → `diagnoseQuery(client, sql)` → `formatQueryDiagnosis(result)`
     (`src/clickhouse/query-diagnosis.ts`, `src/tools/diagnose-query.ts`).
   - Migration → `dryRunMigration(client, { statement, defaultDatabase })` →
     `formatMigrationResult(result)` (`src/clickhouse/migration.ts`,
     `src/tools/dry-run-migration.ts`).
4. **Reuse one read-only client** (`ClickHouseHttpMetadataClient`) across all
   files; close it in `finally`.
5. **Print** a per-file header + the existing formatter output, then a summary.
6. **Exit** with the aggregate code (below).

## Exit codes

- `0` — clean: no failing findings (and, without `--strict`, advisory-only is
  still 0).
- `1` — findings that fail the gate (see policy).
- `2` — operational error: file not found, empty/multi-statement, unknown
  statement type, parse rejection, or connection failure.

### Fail policy (what makes exit 1)

- **Query:** any finding with `confidence: "proven"` (EXPLAIN-backed: full scan,
  missing partition/primary-key pruning). Advisory findings print but do **not**
  fail unless `--strict`.
- **Migration:** classification ∈ `{ part-rewriting, risky-materialized-column,
  unsupported }` fails; `metadata-only` passes. (`--strict` does not change this;
  migrations are already gated conservatively.)

This keeps the gate honest: it fails on proven problems, not on advice.

## Output format

Human (default):

```
▸ queries/revenue.sql  (SELECT)
<formatQueryDiagnosis output>

▸ migrations/2026_06_add_events.sql  (ALTER)
<formatMigrationResult output>

Summary: 1 of 2 file(s) have findings. ✗
```

`--json` (optional v1, recommended for CI/agents): one array of
`{ file, kind, ok, findings | classification, ... }`, reusing the existing
result types so nothing is re-derived.

## Files to add / touch

- **New** `src/commands/verify.ts` — `runVerifyCommand(args, env)`: arg parsing
  (`--strict`, `--json`, file list), client lifecycle, per-file loop, exit-code
  aggregation, output. Keep `cli.ts` thin.
- **New** `src/clickhouse/statement.ts` — `stripSqlComments(sql)` and
  `detectStatementKind(sql): "query" | "migration" | "unknown"`. Reuse the
  quote/paren-aware scanning approach already in `query-validator.ts` /
  `migration-parser.ts` (factor the comment/quote masking out so all three
  share it rather than a fourth copy).
- **Edit** `src/cli.ts` — add the `verify` command branch (dispatch to
  `runVerifyCommand`) and a help line.
- **Reuse, unchanged:** `diagnoseQuery`, `formatQueryDiagnosis`,
  `dryRunMigration`, `formatMigrationResult`, `readClickHouseConfig`,
  `ClickHouseHttpMetadataClient`. Optionally `recordAudit` per file for parity
  with the MCP path.

## Decisions to confirm before building

1. **Comment stripping vs. rejecting** — v1 strips comments so real files work
   (recommended). Alternative: reject comment-bearing files (simpler, worse UX).
2. **`--json` in v1 or defer** — small now, and it's what `--changed`/CI/agent
   will consume; recommend including it.
3. **Audit logging from the CLI** — record verify runs to `GOZZLE_AUDIT_LOG` for
   parity, or keep the CLI silent? (Lean: record, with file path fingerprinted
   like the MCP path.)

## Tests

- `stripSqlComments`: line + block comments, markers inside strings/backticks
  left intact, no statement mutation.
- `detectStatementKind`: SELECT/WITH → query, ALTER → migration, others →
  unknown; leading comments ignored.
- `runVerifyCommand` with a fake `ClickHouseMetadataClient`:
  - clean query → exit 0; proven finding → exit 1; advisory-only → 0, and 1 under
    `--strict`.
  - `metadata-only` migration → 0; `part-rewriting` → 1.
  - multi-file aggregation → worst exit code wins.
  - missing file / unknown statement / no connection → exit 2 with a clear
    message.

## Verification (manual, end-to-end)

Against the Docker ClickHouse used by the integration tests:

```bash
echo 'SELECT * FROM events WHERE toDate(ts) = today()' > /tmp/q.sql
GOZZLE_CLICKHOUSE_URL=... gozzle verify /tmp/q.sql        # expect proven finding, exit 1
echo 'ALTER TABLE events ADD COLUMN x UInt8' > /tmp/m.sql
gozzle verify /tmp/m.sql                                   # metadata-only, exit 0
```

## Immediate follow-on (separate, builds on this)

- `gozzle verify --changed` / `--diff <range>` — resolve changed `.sql`/migration
  files via git, then run this same path over them.
- `gozzle.yaml` — connection profiles, query/migration globs (for discovery), and
  the `assumptions` block that unlocks the read-path dedup proof.
