# gozzle Product Direction

Supersedes the earlier "workload-aggregation brain" framing. The wedge is not a
cluster scanner or a hosted brain — it is a **read-only test harness for
ClickHouse changes** that proves whether a query or migration is safe against the
real cluster, every time a developer touches ClickHouse SQL.

## The reframe

> Stop: "point gozzle at a cluster and find issues."
> Start: "every time a developer changes ClickHouse SQL, gozzle proves whether
> the change is safe against the real cluster."

"Scan my cluster" is an **event**. "Verify this change" is a **habit**. Developers
don't decide to audit a database; they change a query, open a PR, add a migration,
or accept agent-generated SQL. gozzle must attach to that change surface.

Core primitive:

```bash
gozzle verify ./queries/revenue.sql
gozzle verify --changed          # prove the ClickHouse impact of this branch
```

Identity:
- Primary: **the read-only test harness for ClickHouse changes.**
- AI sub-positioning: **the proof layer for ClickHouse agents** — the official
  ClickHouse skill gives advice; gozzle proves whether the advice survives contact
  with the user's real schema and data.

## Two ideas that make it work

**1. Repo context, not cluster memory.** gozzle needs *project configuration*, not
a stateful hosted brain. A `gozzle.yaml` declares where SQL lives, the read-only
connection profile, and — critically — **assumptions** (uniqueness, append-only,
engine). This is local and versioned, like `tsconfig`/`dbt_project.yml`.

```yaml
connection: clickhouse-prod-readonly
queries: [app/**/*.sql, dashboards/**/*.sql, dbt/models/**/*.sql]
migrations: [migrations/**/*.sql]
assumptions:
  events: { unique_by: [event_id], engine: ReplacingMergeTree }
  raw_events: { append_only: true }
```

**2. Read-path proof, not "duplicates exist."** Sophisticated users expect
duplicates in ReplacingMergeTree *storage*; the bug is a read path that trusts
uniqueness the data violates. The wow output is:
`revenue_by_customer.sql` reads `events` as if `event_id` is unique, but the table
currently has N unresolved duplicate keys → this query can overcount.

The declared `assumptions` block is what makes this **tractable**: instead of
inferring uniqueness intent from arbitrary SQL (a research problem), gozzle checks
(a) does current data violate the declared key (`verify_dedup`), and (b) does the
query read that table without FINAL/dedup. Lead with the qualitative violation;
treat an exact "overcounts by X%" as a later stretch (needs bounded execution).

## Commercial guardrail (the line we will not cross for free)

**Local / one-shot / non-persisted = free, build now. Hosted / persisted / team /
shared = paid, hold off.** We do not build the paid moat for free. Anything that
could be the team/CI product is parked until the paid layer.

The habit-forming surfaces are the ones that fire automatically — a CI exit code
and the agent auto-trigger — *not* the manual command (most branches don't touch
ClickHouse, so `verify --changed` is often empty). We ship the free primitives
that enable both, but **not** the productized team CI integration.

## Build now — free / local only

1. **Release a real `latest`.** Not just a dist-tag flip: commit + publish the
   current working tree (includes the P0 large-table dedup safety guard), then
   point `latest` at it. The default install must be safe on big tables.
2. **`gozzle.yaml`** — config loader: connection profile, query/migration globs,
   `assumptions` (unique_by / append_only / engine). Local, versioned.
3. **`verify --query <file>` / `verify --changed` / `--diff`** — run the existing
   verifier engine over changed SQL/migrations; exit non-zero on findings so users
   can wire it into *their own* CI. (We provide the primitive, not a hosted Action.)
4. **Read-path / assumption-violation proof** — declared-intent version: for each
   query on a declared-unique table, prove data violates the key + the query lacks
   FINAL. Qualitative first; exact percentages deferred.
5. **Local discovery** — repo globs first (`.sql`, migrations, dbt/sqlmesh); then a
   one-shot, **non-persisted** `system.query_log` import (discovery, not
   monitoring).
6. **Agent trigger skill** — local: when ClickHouse SQL/migrations are written,
   modified, or reviewed and a `gozzle.yaml` exists, the agent runs gozzle to
   verify before presenting a final answer.
7. **`scan_cluster` / `inspect_table`** — keep as onboarding / first-run wow /
   design-partner measurement, not the daily habit.

## Hold — paid (hosted / persisted / team)

Do **not** build these now; they are the paid layer:
- Hosted CI / GitHub-GitLab App that posts PR comments.
- Shared or persisted proof-artifact history (server-side storage).
- Team policy config, required-checks management, per-seat licensing.
- Any retained cluster/workload state or monitoring over time (the rejected
  "brain").

## Later (bigger local features, after retention is proven)

- Materialized-view correctness — a real build; next bet once branch-verification
  shows retention.
- Inferring uniqueness assumptions from SQL (vs. declared) and exact overcount %.

## Commercial split

- **Free / local:** CLI, MCP server, `gozzle.yaml`, `verify --query/--changed`,
  local + one-shot discovery, local proof output, non-zero CI exit code, agent
  skill, `scan_cluster`.
- **Paid / hosted:** GitHub/GitLab app + PR comments, shared/persisted proof
  history, team policy + required checks, license/seat management.

Teams already pay for CI guardrails (typecheck, security scan, lint). "Correctness
gate for ClickHouse changes" fits that budget — but only the *hosted/team* form is
paid; the local primitive is free and open source.

## What this changes about what's built

- **Keeper (the asset):** the verifier engine — `dedup.ts`, `migration.ts`,
  `query-diagnosis.ts`, introspection, the read-only client. `verify --changed`,
  the agent, and (later) CI all reuse it. Nothing is wasted.
- **New free workflow layer to build:** `gozzle.yaml` loader → discovery /
  `--changed` / `--diff` → assumption-violation proof → agent trigger skill.
- **Demoted to supporting/onboarding:** `inspect_table` + `scan_cluster`;
  `create_local_slice` (reproduce a finding offline, not a headline).
- **Website:** reframed from "safety harness / brain" to "test harness for
  ClickHouse changes." (Hero copy already updated.)

## Validation metric

Not "number of clusters with duplicates." The metric is the **non-empty
meaningful finding rate** — users who say *"I didn't know this, and I need to fix
it,"* tied to a named query, dashboard, or migration they care about. Have 5–10
ClickHouse users run init → discover → verify --changed → scan, and measure: did
it surprise them, was it tied to something they care about, would they put it in
CI, did they trust the read-only/local posture, did they understand the output
without ClickHouse expertise.
