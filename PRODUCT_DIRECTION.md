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

**The precise claim:** the unproductized gap is *agent-native,
execution-verified migration & query correctness*. Adjacent tools exist but each
misses a different axis — launch copy must name-drop and dismiss them, because
reviewers will ask "isn't this just X?":

- **Squawk / Atlas (Postgres migration linters)** — advisory: they check the
  statement *reads* safe against rules. → "They lint the SQL; gozzle runs it on
  your real data and shows you the 12k rows it nulls." (Our advisory-vs-execution
  axis.)
- **datafold / data-diff** — diff two *existing* datasets; they don't verify an
  artifact's correctness or shadow a migration.
- **dbt-audit-helper / dbt unit tests** — manual comparison macros, dbt-only.
- **gh-ost / pt-online-schema-change** — solve migration *locking* (online schema
  change); say nothing about *data correctness*. (Reinforces guardrail C: we own
  data impact, not lock mechanics.)

These are all older (a 180-day-repo probe can't see them) and none are
agent-native or execution-verified — that absence is the gap, but it means the
"open lane" is precisely the tightly-framed claim above, not a broad one.

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
| `verify_equivalent` | two queries return the same result | all | **shipped, exact-in-source** |
| `verify_grain` | no JOIN fan-out / double-counting | all | later |
| `verify_incremental` / `verify_semantics` | MV vs recompute; NULL/tz/float footguns | all | later |

## Guardrails (where the widening must not cut corners)

These encode deliberate pushback on the spec.

**A. Exactness over sampling — protect the meaning of `correct`.** `correct` is
only ever returned from an **exact** check (full scope, or a full local
replica), as `verify_dedup` does today. Sampling is a labeled, probabilistic
fallback that may return `likely-correct`/`indeterminate` but **never
`correct`**. Capping the free tier's sample size is forbidden.

*Scope correction (vs. research that called sampling "pre-R0, the whole
company"):* sampling does **not** gate R0/R1. Every R0/R1 check — `verify_dedup`,
read-path, `verify_equivalent`, migration impact-counts — is **exact-in-source**
(the engine computes over all N rows; nothing is sampled), so "never a false
`correct`" there is guaranteed by exactness, not by a representative slice.
Sampling only bites where we must locally replicate **and** the scope exceeds
budget — i.e. **migration shadow-execution data-correctness (R2)** and the
sampled fallback. So sample auto-sizing (open Q1) is the gate for the **R2
migration flagship**, and warrants a focused spike **during R1, before
committing R2** — earlier than the licensing call, but not pre-R0.

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

**Trigger reconciliation (vs. research point 3).** Agents under-trigger the MCP
skill, so the skill alone is a flaky acquisition surface. But the fix does **not**
require paying: a **local PostToolUse hook** is just agent config — free,
deterministic, no hosted service — and `gozzle verify` returning a non-zero exit
in the user's *own* CI is likewise free and deterministic. So the free tier gets
a **reliable local trigger**, which keeps "free OSS is the distribution engine"
honest. What's actually paid is **org-wide enforcement + central visibility**
(required checks across a team, shared history) — not "determinism." Concretely:
ship a free PostToolUse-hook recipe alongside `gozzle skill`; reserve org policy
for Team. The free distribution engine is really the red-diff demo + the
local hook/CLI in a dev's own hands — not the soft skill prompt.

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
- **R4 — depth + ecosystem** (`verify_grain`/`incremental`/`semantics`; dbt +
  Drizzle/Prisma), driven by what paying users pull. (`verify_equivalent` already
  shipped ahead of schedule as the contract-validating check.)

Every phase ships a real red/green diff on a relatable bug as its launch
artifact.

**Sequencing risk — the beachhead and the flagship live in different tribes.**
R0/R1 earn ClickHouse-community stars on `verify_dedup` (a small pond where the
warm node lives); R2 pivots the hero to **Postgres migration**, a far larger TAM
where there is **no warm distribution** and a different audience. ClickHouse
stars will not automatically carry the Postgres-migration crowd. Decide
deliberately, before R2: treat the ClickHouse launch as **engine-credibility +
proof-of-concept**, and budget a **separate distribution motion for R2**
(Drizzle/Prisma/Alembic communities, the migration-pain writers, a fresh
launch) — do not assume transfer. If migration is truly the flagship, an
alternative is to bring a Postgres `verify_migration` demo forward into the R1
launch so the two audiences are courted together rather than sequentially.

## Open questions

1. **Sample auto-sizing** — what guarantees a slice surfaces low-frequency /
   skewed-key divergence without replicating whole tables? Gates the **R2
   migration flagship** (not R0/R1, which are exact-in-source). Highest-risk
   open problem; spike during R1 before committing R2.
2. **ClickHouse → Postgres distribution transfer** — is the R1 ClickHouse launch
   a real flywheel for the R2 migration audience, or proof-of-concept needing a
   separate R2 launch? Decide before R2 (see Rollout sequencing risk).
3. **chDB vs DuckDB boundary** — DuckDB default; chDB for ClickHouse-native
   semantics (R2 decision).
4. **Smallest hosted surface that lands the first Team** (shareable reports +
   history) vs full governance.
5. **Integration priority** — dbt vs Drizzle/Prisma first.

Resolved: free OSS core (already shipped); license Apache-2.0 + closed Pro/hosted;
hosted committed but gated to R3 with privacy guardrails.
