# gozzle Product Direction

Supersedes the earlier change-harness note. Incorporates the widened spec
(draft v0.3) with explicit guardrails where the widening risks the one asset
that makes gozzle defensible: the trustworthiness of a `correct` verdict.

> **One-liner:** Execution-verified correctness for agent-produced data & code
> artifacts. gozzle runs the artifact against real data, proves whether it's
> correct, and hands back a shareable red/green diff.
>
> **Public pitch through R1 stays ClickHouse-led** ("prove your agent's
> ClickHouse query/migration is correct"). Vendor-neutral is the architecture,
> not yet the marketing.

## Where we are today (be honest about this)

Shipped `@gozzle/cli@0.1.4`, ClickHouse-only, Apache-2.0/OSS, free: CLI + MCP +
`gozzle skill`, `verify <file>/--changed/--diff/--all`, `gozzle.yaml` +
read-path proof, `discover` (query_log), `dry_run_migration` (metadata-only),
`create_local_slice` (chDB, single-partition RMT). **We have passed zero R0
gates** — no design partner, no confirmed real bug caught for a partner, no live
run against a real cluster yet. Everything below is sequenced behind closing
that gap first.

## Positioning (two axes that keep us sharp)

- **Artifact-correctness, not run-verification.** We verify the *thing produced*
  (the query/migration), never the *agent process*. Run-verification (Braintrust,
  Langfuse, Phoenix, Laminar) is crowded and not ours. Never grow into
  tracing/eval.
- **Execution-verified, not advisory.** Advisory tools (official ClickHouse
  skill, linters) inject *rules*; gozzle *executes and proves* them against real
  data. We are a **complement** to advisory skills — pursue cross-listing, don't
  compete.

**Not:** agent observability; an orchestrator; an advisory linter; a
semantic/metrics layer (that is hypequery).

## Core engine (north star)

One loop, reused across every check and engine:

```
detect → replicate (locally) → run [as-written] + [reference] → diff → verdict → report
```

A pluggable `ExecutionBackend` keeps the loop engine-agnostic (introspect /
replicate / run / reference). **chDB** is the proven ClickHouse backend today;
**DuckDB** (Postgres/MySQL/generic) is the R2 expansion. The interface is the
architectural north star **now**; the second backend is built **only after the
R1 gate** (see guardrail B).

## Check catalog

| Check | Proves | Engines | Status today |
|---|---|---|---|
| `verify_dedup` | result matches settled merge/dedup state | ClickHouse (Postgres later) | **shipped, exact** |
| read-path proof | a query trusts uniqueness the data violates | ClickHouse | **shipped** |
| `dry_run_migration` | classify + estimate touched data (metadata) | ClickHouse | **shipped (metadata-only)** |
| `verify_migration` | shadow-run a migration; prove **data impact** | Postgres/MySQL/CH | **flagship to build (R2)** |
| `verify_equivalent` | two queries return the same result | all | next-most-valuable; pull earlier if partners want it |
| `verify_grain` | no JOIN fan-out / double-counting | all | later |
| `verify_incremental` / `verify_semantics` | MV vs recompute; NULL/tz/float footguns | all | later |

## Guardrails (where the widening must not cut corners)

These encode deliberate pushback on the spec.

**A. Exactness over sampling — protect the meaning of `correct`.** `correct` is
only ever returned from an **exact** check (full scope, or a full local
replica), as `verify_dedup` does today. Sampling is a labeled, probabilistic
fallback that may return `likely-correct`/`indeterminate` but **never
`correct`**. Capping the free tier's sample size is forbidden. Sample
auto-sizing (open Q1) is the gating research problem for everything beyond exact
checks — not just an engine detail.

**B. Beachhead-first sequencing.** Stay ClickHouse-led, single-backend, through
R0–R1. Do not build DuckDB, Postgres migration, more checks, or hosted infra
until the R1 gate is met. The `ExecutionBackend` interface may exist as design;
the second backend may not be implemented early.

**C. `verify_migration` = data impact, not lock duration.** Run the migration on
a **full local replica** and diff: rows touched / nulled / dropped, row-count
drift. That is honest and locally verifiable. **Lock duration and operational
impact are production-cluster properties a local slice cannot predict** — do not
emit a number for them (a static, clearly-advisory heuristic at most). A wrong
lock estimate violates guardrail A.

**D. Hosted control plane must not silently break local-first.** Shareable
hosted reports contain table names, query text, and divergent-row samples — i.e.
production data leaving the machine. Hosted is gated behind R2 revenue and must
be opt-in, redact row samples by default, and prefer customer-controlled
storage. The free/local path always stays fully local.

## Surfaces & distribution (shipped)

MCP server (the "verify before done" agent loop) · `gozzle skill` (the trigger)
· CLI (humans + CI exit code) · CI gate/PR comment (paid). BYOK, local-first,
multi-agent, global or project-local install. **The diff report is a first-class
product** — glanceable verdict, engine context, row/impact delta, divergent-row
sample, suggested fix, honesty footer (`sampled N rows · local · 1.4s`); HTML to
share, MD for PRs/agents.

## Packaging, licensing & gating

- **License:** Apache-2.0 OSS core; Pro features + hosted control plane closed.
  The moat is the closed layer + operated infra + hypequery distribution + the
  depth of the reference-rule library — not the license.
- **Gate on team / scale / ops, never on correctness-confidence.** The free
  individual experience is fully, genuinely useful — that is the distribution
  engine.

| Tier | Gets | Gated on | Price |
|---|---|---|---|
| **OSS core** | engine, CLI, skill, MCP, **every check**, full local verdicts + diff reports, self-host | — | Free, Apache-2.0 |
| **Pro** | CI gating, persistent hosted shareable reports, history, hosted control plane, all backends | automation + collaboration + operated convenience | card-required (~$39–49/dev/mo) |
| **Team** | org-policy enforcement, audit, SSO/RBAC, shared config, cluster-scoped creds | org governance at scale | hybrid per-cluster |

Free-riding a team's local CLI doesn't *enforce* org-wide or give *central
visibility* — that gap is the willingness-to-pay.

## Rollout

- **R0 — private alpha · ClickHouse `verify_dedup`** ← **we are here (product
  built, not yet validated).** Hand-install with hypequery + warm ClickHouse
  contacts. Gate: 5–10 design partners · ≥1 confirmed real bug each · "I'd keep
  using this." **Also required before R1: one live run against a real cluster**
  (still outstanding) to verify `verify_dedup`, the read-path proof, and
  `discover`'s query_log SQL.
- **R1 — public OSS launch · skill + MCP + CLI.** Marketplaces, ClickHouse
  amplification, red-diff Show-HN. No paid tier. Gate: install/star traction · N
  active repos · ≥2 inbound purchase-intent signals.
- **R2 — broadening + first revenue · DuckDB + Postgres `verify_migration`
  (data-impact); Pro launches** (card-required). Gate: first paying devs ·
  month-1 retention · pull for shared/org features.
- **R3 — Team + hosted control plane** (opt-in, redacted; guardrail D). Gate:
  first Team accounts · multi-seat expansion.
- **R4 — depth + ecosystem** (`verify_equivalent`/`grain`/`incremental`/
  `semantics`; dbt + Drizzle/Prisma), driven by what paying users pull.

Every phase ships a real red/green diff on a relatable bug as its launch
artifact.

## Open questions

1. **Sample auto-sizing** — what guarantees a slice surfaces divergence without
   replicating whole tables? Gates guardrail A and every non-exact `correct`.
2. **chDB vs DuckDB boundary** — DuckDB default; chDB for ClickHouse-native
   semantics (R2 decision).
3. **Smallest hosted surface that lands the first Team** (shareable reports +
   history) vs full governance.
4. **Integration priority** — dbt vs Drizzle/Prisma first.

Resolved: free OSS core (already shipped); license Apache-2.0 + closed Pro/hosted;
hosted committed but gated to R3 with privacy guardrails.
