# gozzle Product Surface Review

This document summarizes the current gozzle product as it exists in the repo:
what the full surface is, what is strong, what is weak, and how the product
should be positioned.

## Executive Summary

gozzle is currently a local, read-only verification layer for ClickHouse work
produced by humans or AI agents. It exposes the same core checks through three
surfaces:

- an MCP server for agents;
- a CLI for humans, hooks, and CI;
- a documentation website.

The strongest product wedge is not “ClickHouse toolkit” and not “MCP server.”
The wedge is:

> Agent verification for ClickHouse changes.

More precise:

> Your AI changed ClickHouse SQL. gozzle proves whether it is safe.

That is the useful, differentiated claim. Agents can generate ClickHouse SQL
quickly, but they cannot know whether the result is safe against the real table
shape, current data, ClickHouse part layout, ReplacingMergeTree behavior, or
migration rewrite blast radius. gozzle gives the agent an external verification
layer with bounded, read-only checks.

## Current Product Surface

### 1. MCP Server

Entrypoint:

- `gozzle-mcp`
- implementation: `packages/cli/src/mcp/server.ts`

Tools exposed:

- `health`
- `connect`
- `inspect_table`
- `verify_dedup`
- `verify_equivalent`
- `create_local_slice`
- `dry_run_migration`
- `diagnose_query`

This is the core agent surface. It lets Claude, Cursor, Codex, and other MCP
hosts ask gozzle for proof rather than guessing from model reasoning.

What is good:

- Clear tool boundaries.
- All ClickHouse-backed tools run through a shared connection wrapper.
- Tools return plain text and, for several tools, structured output.
- Audit logging exists and is off by default.
- Tools are local-first and read-only by construction.

What is weak:

- Structured output contracts are inconsistent across tools.
- Some tools return rich structured content; others are mostly prose.
- Agents still need good instruction/hook integration to call tools reliably.
- The MCP surface does not yet expose one unified “verdict/method/coverage”
  contract.

### 2. CLI

Entrypoint:

- `gozzle`
- implementation: `packages/cli/src/cli.ts`

Commands:

- `gozzle verify`
- `gozzle discover`
- `gozzle equivalent`
- `gozzle init`
- `gozzle skill`
- `gozzle hook`
- `gozzle slices`
- `gozzle version`

What is good:

- The CLI makes gozzle useful outside an agent.
- `verify` gives a CI/pre-commit path through exit codes.
- `equivalent` gives a focused human workflow for query rewrites.
- `hook` creates a deterministic path so verification does not rely only on
  agent discretion.
- `slices` provides lifecycle control for persistent local data copies.

What is weak:

- `verify` currently flattens migration outcomes too aggressively. Any
  non-metadata-only migration fails, but the failure reason is not as nuanced as
  the underlying migration result.
- `verify` JSON omits some useful fields, especially migration correctness
  findings.
- `verify_equivalent` is a separate command, not yet integrated into changed-file
  verification workflows.
- There is no single “gozzle doctor” or “demo” command for first-run onboarding.

### 3. Project Config

File:

- `gozzle.yaml`
- implementation: `packages/cli/src/config/project.ts`

Current concepts:

- default database;
- query globs;
- migration globs;
- table uniqueness assumptions through `assumptions.<table>.unique_by`.

What is good:

- Small and understandable.
- Enables `verify --all`, `verify --changed`, and `verify --diff`.
- Turns read-path proof into a repo-level contract.

What is weak:

- Only one class of semantic assumption exists today: uniqueness.
- No team policy layer.
- No per-check severity/allowlist/ignore mechanism.
- No declared expected tables or environments.

### 4. Query Diagnosis

Tool:

- `diagnose_query`
- implementation: `packages/cli/src/clickhouse/query-diagnosis.ts`

What it does:

- Accepts one `SELECT` or `WITH ... SELECT`.
- Runs `EXPLAIN indexes = 1, projections = 1`.
- Parses MergeTree index evidence.
- Reports full scans, missing partition pruning, and missing primary-key
  pruning as proven findings when EXPLAIN supports them.
- Reports query-shape issues such as `FINAL`, function-wrapped predicates,
  leading wildcard, broad joins, and `SELECT *` as advisories.

What is good:

- It does not execute the original query.
- It separates proven EXPLAIN evidence from advisory query-shape hints.
- It attaches table ORDER BY / PARTITION BY context so recommendations can be
  concrete.
- It is a strong ClickHouse-native check and gives agents information they
  usually cannot infer.

What is weak:

- EXPLAIN is not runtime proof. It does not prove latency, memory, network
  transfer, join cardinality, or result correctness.
- The output is still more diagnostic than verdict-oriented.
- It can tell a query is expensive-looking, but not whether a rewrite is
  equivalent. That requires `verify_equivalent`.

### 5. ReplacingMergeTree Dedup Verification

Tool:

- `verify_dedup`
- implementation: `packages/cli/src/clickhouse/dedup.ts`

What it does:

- Verifies whether a ReplacingMergeTree-family table currently contains
  duplicate rows by sorting key.
- Distinguishes rows collapsible by background merges inside partitions from
  rows collapsible by `FINAL`.
- Supports partition-scoped proof.
- Refuses oversized unscoped scans when guardrails are configured.

What is good:

- This is one of the clearest exact-source checks in the product.
- It addresses a real ClickHouse footgun that agents frequently miss.
- It produces concrete evidence: duplicate groups, duplicate rows, max copies,
  and sample keys.
- It gives a real “proof against current data” story.

What is weak:

- It is specific to ReplacingMergeTree-family engines.
- Users must understand sorting keys, partitioning, and `FINAL`.
- It can be expensive on large tables unless scoped or guarded.
- It is not currently packaged as a “first demo dataset” experience.

### 6. Read-Path Proof

Surface:

- part of `gozzle verify`
- implementation: `packages/cli/src/commands/verify-read-path.ts`

What it does:

- Uses `gozzle.yaml` uniqueness assumptions.
- Flags queries that read a table without `FINAL` while trusting uniqueness that
  current data violates.

What is good:

- This connects repo-level assumptions to live data.
- It catches silent overcounting, one of the clearest business-value bugs.
- It turns gozzle from “query inspector” into “artifact verifier.”

What is weak:

- It only covers declared uniqueness assumptions.
- It depends on users maintaining `gozzle.yaml`.
- It is not obvious enough in top-level marketing yet.

### 7. Query Equivalence

Command/tool:

- `gozzle equivalent`
- `verify_equivalent`
- implementation: `packages/cli/src/clickhouse/equivalent.ts`

What it does:

- Compares two SELECT queries as multisets using `EXCEPT ALL`.
- Runs entirely in ClickHouse.
- Returns `correct`, `incorrect`, or `indeterminate`.
- Detects result-shape mismatch and renamed columns.
- Rejects non-deterministic queries.

What is good:

- This is the cleanest verification contract in the product today.
- It is exact-source and does not copy data out.
- It maps directly to agent workflows: “I rewrote this query; prove it returns
  the same rows.”
- It validates the broader product direction better than advisory diagnosis.

What is weak:

- It can be expensive for large query outputs.
- It is not integrated into `gozzle verify --changed` as a natural before/after
  comparison.
- It requires the user or agent to provide both old and new queries.
- It does not yet provide rich coverage metadata beyond exact-source method.

### 8. Migration Dry Runs

Tool:

- `dry_run_migration`
- implementation:
  - `packages/cli/src/clickhouse/migration-parser.ts`
  - `packages/cli/src/clickhouse/migration.ts`
  - `packages/cli/src/tools/dry-run-migration.ts`

What it does:

- Accepts one `ALTER TABLE` statement.
- Classifies metadata-only, part-rewriting, risky materialized-column, and
  unsupported operations.
- Estimates rewrite footprint using table metadata or predicate-to-part scans.
- Runs read-only correctness checks for:
  - mutation predicates;
  - UPDATE assignment expressions;
  - MODIFY COLUMN casts;
  - DEFAULT/MATERIALIZED column expressions.

What is good:

- It never executes the production ALTER.
- It correctly separates rewrite impact from correctness checks.
- It rejects unsupported, compound, external-access, and ambiguous operations
  rather than overclaiming.
- The newest correctness gate is the right direction: validate expressions and
  casts against current live data without mutating production.

What is weak:

- It is still not full migration shadow execution.
- It does not prove lock time, merge behavior, replication lag, operational
  impact, or future data correctness.
- Partition-scoped mutations are rejected.
- Docs still lag the implementation.
- The top-level product language must avoid saying “migration correct” when
  only read-only expression/cast checks and rewrite estimates were performed.

### 9. Local Slices

Tool:

- `create_local_slice`
- CLI lifecycle:
  - `gozzle slices`
- implementation:
  - `packages/cli/src/local-engine/slice.ts`
  - `packages/cli/src/local-engine/chdb.ts`
  - `packages/cli/src/local-engine/slice-store.ts`

What it does:

- Copies one complete ReplacingMergeTree partition to local chDB through
  Parquet.
- Replays a normalized DDL.
- Re-runs dedup proof against source and local data.
- Persists the workspace until explicit cleanup.

What is good:

- It is careful about partition completeness.
- It has row, byte, and total-storage budgets.
- It warns that copied data persists locally.
- It verifies the local slice against source proof.

What is weak:

- It is advanced and operationally sensitive.
- It copies production data to disk.
- It is persistent, not ephemeral.
- It should not be the public hero until there is an automatic ephemeral
  verification lifecycle with cleanup.

### 10. Discovery

Command:

- `gozzle discover`
- implementation:
  - `packages/cli/src/commands/discover.ts`
  - `packages/cli/src/clickhouse/query-log.ts`

What it does:

- Reads recent SELECTs from `system.query_log`.
- Ranks workload candidates.
- Helps users find real queries to verify.

What is good:

- Useful for onboarding and real-cluster audits.
- Lets users find high-value checks without already knowing where SQL lives.

What is weak:

- It is secondary to the core verification story.
- Query-log permissions and retention vary by cluster.
- It is not yet part of a polished “first value” flow.

### 11. Agent Setup

Commands:

- `gozzle init`
- `gozzle skill`
- `gozzle hook`

Implementation:

- `packages/cli/src/init/mcp-config.ts`
- `packages/cli/src/init/agent-skill.ts`
- `packages/cli/src/init/hook-recipe.ts`

What is good:

- Covers Claude Code, Cursor, and Codex for MCP config snippets.
- Avoids printing passwords from env into generated config.
- Gives both soft instruction (`skill`) and deterministic hook (`hook`).

What is weak:

- Hook story is currently Claude-specific.
- Skill instructions are inherently discretionary.
- Positioning should emphasize deterministic local verification rather than
  hoping the agent remembers.

### 12. Website And Docs

Path:

- `apps/web`

What is good:

- The site has a distinctive terminal-like visual identity.
- The docs cover read-only behavior, guardrails, local slices, audit logs,
  verify, dry-run migration, and diagnose-query.
- The homepage is much stronger than the root README.

What is weak:

- The hero slightly overclaims with “verified correct.”
- Docs lag the newest migration correctness behavior.
- Build currently warns about missing `metadataBase`.
- Root README is much weaker than the website and npm package story.

## What Is Good Overall

- **Strong wedge:** AI-generated ClickHouse SQL needs an external verification
  layer.
- **Read-only design:** `readonly=2`, bounded settings, and no production writes
  are the right foundation.
- **Real checks, not wrappers:** dedup, read-path proof, equivalence, query
  diagnosis, and migration dry-run all encode ClickHouse-specific knowledge.
- **Multi-surface distribution:** MCP for agents, CLI for humans/CI, hooks for
  deterministic verification.
- **Local-first trust:** no hosted dependency, no data exfiltration by default.
- **Good engineering base:** TypeScript, tests, GitHub workflows, release
  automation, security policy, audit logging.
- **Good north star:** exact-source proof where possible; local replication only
  when truly needed.

## What Is Not Good Yet

- **Positioning is not fully consistent.** Internal strategy says
  “execution-verified artifact correctness,” public docs often say “safety
  harness” or “developer toolkit.” The former is sharper.
- **Verdict language is fragmented.** Different tools use different result
  shapes and confidence concepts.
- **Migration story is easy to overclaim.** Current checks are valuable but do
  not equal full shadow migration execution.
- **Production validation is thin.** There are tests and workflows, but not yet
  public evidence from real clusters or design partners.
- **Docs lag implementation.** Especially migration correctness.
- **Release hygiene has small gaps.** Formatting check currently fails; web
  build has a metadata warning.
- **The first-run demo is not sharp enough.** There should be an obvious
  command sequence that produces a red proof quickly.
- **Team/CI product is not fully formed.** Exit codes exist, but reports, PR
  comments, history, and policy are future work.

## Positioning

### Primary Positioning

> gozzle is the agent verification layer for ClickHouse changes.

### Hero Copy

Recommended:

> Your AI changed ClickHouse SQL. gozzle proves whether it is safe.

Alternative:

> Read-only proof for agent-written ClickHouse queries and migrations.

Subhead:

> gozzle runs local, bounded checks against your real ClickHouse schema and
> current data, catching duplicate reads, bad query rewrites, unsafe casts, and
> mutation blast radius before they ship.

### What To Lead With

Lead with:

- AI agents generate database changes faster than teams can review them.
- ClickHouse has sharp correctness and performance footguns.
- gozzle gives agents and CI a read-only proof layer.
- The result is a verdict with evidence, not a generic lint warning.

Do not lead with:

- “MCP server”
- “developer toolkit”
- “local slices”
- “chDB”
- “observability”

Those are mechanisms. The buyer/user problem is trust in generated ClickHouse
artifacts.

### Differentiation

Against official ClickHouse MCP:

- Official MCP is a query gateway.
- gozzle is a verification layer.

Against linters:

- Linters inspect syntax and known rules.
- gozzle runs bounded checks against real schema and current data.

Against observability/eval products:

- They evaluate agent runs.
- gozzle verifies the database artifact the agent produced.

Against data diff tools:

- They compare existing datasets.
- gozzle verifies a proposed query or migration artifact before it ships.

## Recommended Product Narrative

1. AI writes or changes ClickHouse SQL.
2. gozzle receives the artifact through MCP, CLI, hook, or CI.
3. gozzle classifies the artifact.
4. gozzle runs the strongest safe check available:
   - exact-source proof where possible;
   - read-only live-data validation for migration expressions/casts;
   - EXPLAIN-backed proof for pruning behavior;
   - advisory findings only where proof is not possible.
5. gozzle returns a verdict with evidence and clear limits.
6. The agent or CI blocks, fixes, or proceeds.

## Current Production Readiness

For OSS alpha/canary:

> 8/10

For production release:

> 6.5/10

The core is credible and useful. The main blockers are not the amount of code,
but consistency and trust:

- unified verdict contracts;
- no overclaiming in hero/docs;
- real-cluster validation evidence;
- release hygiene;
- migration documentation matching implementation.

## Suggested Next Product Milestone

Ship a “proof-first public alpha”:

- homepage and README repositioned around agent verification;
- docs updated for current checks and limits;
- one clean demo showing a real failing ClickHouse query or migration;
- unified structured verdicts for MCP;
- `gozzle verify` JSON rich enough for CI and agents;
- formatting/lint/build/test/release gates clean.

Do not broaden beyond ClickHouse until this milestone lands. The product is
strongest when it is narrow, exact, and honest.
