# gozzle PRD: Verification Engine For AI-Generated ClickHouse Changes

Status: draft PRD  
Audience: product, engineering, launch planning  
Stage: pre-release, breaking changes allowed  
Primary implementation package: `packages/cli`

## 1. Summary

gozzle should become the verification engine for AI-generated ClickHouse
changes.

The product should not feel like a bag of separate ClickHouse tools. A user or
agent should submit an artifact, and gozzle should decide the strongest safe
verification strategy automatically.

Core flow:

```text
Artifact -> classify -> plan -> execute checks -> evidence -> verdict
```

Primary public promise:

> Your AI changed ClickHouse SQL. gozzle proves what can be proven, checks what
> can be checked, and clearly labels what remains uncertain.

Short positioning:

> Agent verification layer for ClickHouse changes.

Long-term positioning:

> Verification infrastructure for AI-generated analytics changes.

## 2. Why This Product Exists

AI agents can write SQL, migrations, and analytics code faster than humans can
review them. Existing tools can run queries, lint SQL, observe agent traces, or
diff existing datasets. The missing layer is artifact verification:

- Did the query rewrite preserve results?
- Does the query rely on a uniqueness assumption current data violates?
- Will this migration cast fail on existing rows?
- How much data will this mutation rewrite?
- Did the change lose ClickHouse pruning?
- What was actually proven, and what remains advisory?

gozzle answers these questions with bounded, read-only checks against the real
ClickHouse cluster, escalating to local verification only when that materially
improves evidence.

## 3. Current Codebase Baseline

The current repo already contains strong primitives:

- MCP server: `packages/cli/src/mcp/server.ts`
- CLI: `packages/cli/src/cli.ts`
- `gozzle verify`: `packages/cli/src/commands/verify.ts`
- query diagnosis: `packages/cli/src/clickhouse/query-diagnosis.ts`
- query equivalence: `packages/cli/src/clickhouse/equivalent.ts`
- dedup proof: `packages/cli/src/clickhouse/dedup.ts`
- read-path proof: `packages/cli/src/commands/verify-read-path.ts`
- migration dry run and read-only correctness checks:
  - `packages/cli/src/clickhouse/migration-parser.ts`
  - `packages/cli/src/clickhouse/migration.ts`
  - `packages/cli/src/tools/dry-run-migration.ts`
- local slices:
  - `packages/cli/src/local-engine/slice.ts`
  - `packages/cli/src/local-engine/chdb.ts`
  - `packages/cli/src/local-engine/slice-store.ts`
- guardrails: `packages/cli/src/config/guardrails.ts`
- project config: `packages/cli/src/config/project.ts`
- docs site: `apps/web`

The gap is not lack of checks. The gap is orchestration, unified evidence
language, and product coherence.

## 4. Product Goals

### 4.1 Primary Goal

Make `gozzle verify` and the MCP equivalent the primary product surface.

The user should not need to know whether gozzle used `EXPLAIN`, `system.parts`,
`system.columns`, `EXCEPT ALL`, a dedup aggregate, or a local chDB slice. The
planner should choose the strongest safe path and report the result honestly.

### 4.2 User Goals

Users want to know:

- whether an AI-generated SQL change is safe to ship;
- whether a query rewrite preserved result semantics;
- whether a migration will break current data;
- whether ClickHouse-specific behavior such as ReplacingMergeTree duplicates or
  part rewrites creates hidden risk;
- whether a result is proven, advisory, scoped, or indeterminate.

### 4.3 Business Goal

Create a credible OSS alpha that can become a commercial team product.

OSS should include the local verification engine, CLI, MCP, and checks. Paid
surface later should be team workflow: PR comments, hosted reports, history,
policy, audit, and org-level visibility.

## 5. Non-Goals

gozzle must not claim to prove:

- future merge timing;
- production lock duration;
- replication lag;
- distributed cluster saturation;
- cache effects;
- future data correctness;
- arbitrary migration safety;
- all runtime performance characteristics;
- cost improvement from a suggested rewrite.

When proof is impossible, gozzle should return advisory findings with explicit
limits.

## 6. Opinionated Direction And Disagreements

### 6.1 I Agree: Planner Is The Core Product

The planner should become the core abstraction. The current separate tools are
good building blocks, but the product leap is:

```text
From: "Here are eight ClickHouse tools."
To:   "Give gozzle a change. It decides how to verify it."
```

### 6.2 I Agree: Production Read-Only First

Defaulting to production read-only checks is correct. Production has the real
schema, current data, current part layout, and current ClickHouse behavior.
Copying data locally should be an escalation path, not the default.

### 6.3 I Agree With A Tighter Version: Ephemeral Slices

Ephemeral local slices are the right future direction, but they should not be in
the hero until cleanup, budgeting, and permission semantics are implemented.
Persistent `create_local_slice` should remain an advanced tool.

### 6.4 I Disagree: "Cheapest Strategy Capable Of Producing Trustworthy Evidence"

The planner should choose the strongest evidence that fits safety policy and
budget, not merely the cheapest strategy that is trustworthy. Cheap advisory
evidence can be useful, but if exact-source proof is safe and affordable, gozzle
should run it.

Better rule:

> Choose the highest-evidence strategy that satisfies safety, policy, and budget.

### 6.5 I Disagree: Renaming Public Commands Too Early

The suggested surface includes `gozzle diagnose` and `gozzle migration-risk`.
That is not needed before release. The current command vocabulary is acceptable
if `gozzle verify` becomes the main entrypoint.

Keep direct expert commands where they already exist, but avoid multiplying new
top-level names before the planner lands.

### 6.6 I Disagree: Introducing Broad Future Artifact Types In V1 Config

dbt models, semantic models, dashboards, scheduled jobs, and metric tolerances
are attractive, but adding them now would blur the ClickHouse beachhead. The
config should be designed to grow, but the pre-release implementation should
stay narrow:

- query;
- query pair;
- migration;
- repo diff;
- table assumption.

## 7. Target Product Surface

### 7.1 CLI

Primary:

```bash
gozzle verify
gozzle verify --changed
gozzle verify --diff origin/main...HEAD
gozzle verify --all
gozzle verify --before old.sql --after new.sql
gozzle verify --plan-only
gozzle verify --with-slice
```

Existing direct commands remain:

```bash
gozzle equivalent <a.sql> <b.sql>
gozzle discover
gozzle init
gozzle skill
gozzle hook
gozzle slices
```

Direct commands are expert shortcuts. The main product is `gozzle verify`.

### 7.2 MCP

Primary MCP tool:

```text
verify_artifact
```

Recommended input:

```json
{
  "artifactType": "auto",
  "content": "...",
  "path": "optional/path.sql",
  "intent": ["correctness", "cost_risk"],
  "allowLocalSlice": false
}
```

Recommended output:

```json
{
  "verdict": "fail",
  "summary": "Query rewrite changed results.",
  "findings": [],
  "limits": [],
  "nextActions": []
}
```

Keep focused tools:

- `inspect_table`
- `diagnose_query`
- `verify_equivalent`
- `dry_run_migration`
- `verify_dedup`

But agents should be instructed to call `verify_artifact` first.

### 7.3 Website

The website should lead with the artifact verification story:

Hero:

> Your AI changed ClickHouse SQL. gozzle proves whether it is safe.

Subhead:

> gozzle runs bounded, read-only checks against your real ClickHouse schema and
> current data, catching duplicate reads, bad query rewrites, unsafe casts, and
> mutation blast radius before they ship.

Avoid leading with:

- MCP;
- chDB;
- local slices;
- generic “developer toolkit” language.

## 8. Core Domain Model

### 8.1 Artifact

```ts
type ArtifactType =
  | "query"
  | "query_pair"
  | "migration"
  | "repo_diff"
  | "table_assumption"
  | "unknown";
```

### 8.2 Intent

```ts
type VerificationIntent =
  | "correctness"
  | "equivalence"
  | "cost_risk"
  | "read_path_safety"
  | "dedup_safety"
  | "migration_risk"
  | "unknown";
```

Future, not pre-release:

```ts
type FutureVerificationIntent =
  | "semantic_regression"
  | "metric_drift"
  | "null_drift"
  | "join_cardinality";
```

### 8.3 Strategy

```ts
type VerificationStrategy =
  | "static_parse"
  | "metadata_only"
  | "production_explain"
  | "production_bounded_probe"
  | "production_exact"
  | "local_slice_exact"
  | "local_slice_simulation"
  | "advisory";
```

### 8.4 Evidence Level

```ts
type EvidenceLevel =
  | "exact"
  | "bounded"
  | "metadata"
  | "explain"
  | "sampled"
  | "advisory";
```

### 8.5 Verdict

Use one top-level vocabulary:

```ts
type Verdict = "pass" | "fail" | "warn" | "indeterminate";
```

Meanings:

- `pass`: no configured blocking issue found;
- `fail`: at least one blocking issue found;
- `warn`: non-blocking risk found;
- `indeterminate`: gozzle could not gather enough evidence to pass or fail.

Important: a `pass` is a policy outcome, not necessarily global mathematical
correctness. Findings must carry evidence and limits.

## 9. Unified Output Contract

### 9.1 VerificationRun

```ts
interface VerificationRun {
  runId: string;
  createdAt: string;
  artifact: ArtifactSummary;
  verdict: Verdict;
  severity: "none" | "info" | "warn" | "error";
  confidence: EvidenceLevel;
  confidenceByCategory: Partial<Record<FindingCategory, EvidenceLevel>>;
  coverage: CoverageSummary;
  plan: VerificationPlanSummary;
  findings: Finding[];
  limits: Limit[];
  recommendations: Recommendation[];
  audit: AuditSummary;
}
```

### 9.2 Finding

```ts
type FindingCategory =
  | "correctness"
  | "cost"
  | "performance"
  | "semantic"
  | "migration"
  | "governance"
  | "coverage";

interface Finding {
  id: string;
  title: string;
  severity: "info" | "warn" | "error";
  verdict: Verdict;
  category: FindingCategory;
  evidenceLevel: EvidenceLevel;
  strategy: VerificationStrategy;
  message: string;
  evidence: Evidence[];
  limits: Limit[];
  recommendation?: string;
  blocking: boolean;
}
```

### 9.3 Limit

```ts
interface Limit {
  type:
    | "scope"
    | "budget"
    | "timeout"
    | "permissions"
    | "unsupported_syntax"
    | "advisory_only"
    | "sampled"
    | "stale_metadata";
  message: string;
}
```

## 10. Planner Behavior

Planner flow:

```text
parse artifact
classify artifact type
infer verification intents
load project policy
inspect schema and metadata
generate candidate checks
score candidate strategies
select plan
execute with budgets
aggregate findings
return verdict
```

Strategy selection rule:

```text
Choose the highest-evidence strategy that satisfies policy, read-only safety,
budget, and user permissions.
```

Scoring:

```ts
interface StrategyScore {
  evidenceStrength: number;
  operationalRisk: number;
  estimatedCost: number;
  estimatedLatency: number;
  dataMovement: number;
  policyFit: number;
}
```

## 11. Check Registry

The planner should use a registry rather than hardcoded orchestration.

```ts
interface CheckDefinition {
  id: string;
  supportedArtifacts: ArtifactType[];
  intents: VerificationIntent[];
  requiredCapabilities: Capability[];
  candidateStrategies: VerificationStrategy[];
  estimate(context: PlannerContext): CheckEstimate;
  execute(context: ExecutionContext): Promise<Finding[]>;
}
```

Initial checks:

- `query_equivalence`
- `query_schema_compatibility`
- `query_plan_risk`
- `read_path_uniqueness`
- `replacing_merge_tree_dedup`
- `migration_blast_radius`
- `migration_cast_validation`
- `migration_expression_validation`
- `mutation_predicate_validation`

Future checks:

- `semantic_metric_drift`
- `semantic_null_drift`
- `join_cardinality_probe`
- `materialized_view_regression`

## 12. Capability Detection

Capabilities:

```ts
type Capability =
  | "clickhouse_connection"
  | "readonly_session"
  | "system_parts"
  | "system_columns"
  | "system_query_log"
  | "explain_indexes"
  | "explain_projections"
  | "local_chdb"
  | "git_base"
  | "gozzle_config"
  | "table_assumptions";
```

If a capability is missing, planner should skip affected checks and emit a
limit.

Example:

```json
{
  "type": "permissions",
  "message": "system.query_log is not accessible, so workload discovery was skipped."
}
```

## 13. Verification Flows

### 13.1 Single Query

Input:

```text
query.sql
```

Planner:

1. Validate one read-only `SELECT` or `WITH ... SELECT`.
2. Inspect referenced tables.
3. Run EXPLAIN if allowed.
4. Check partition pruning, primary-key pruning, projection/index evidence.
5. Add query-shape advisories.
6. Run read-path assumptions from `gozzle.yaml`.
7. Return verdict.

Default strategies:

- `production_explain`
- `production_bounded_probe`
- `advisory`

### 13.2 Query Pair

Input:

```text
before.sql
after.sql
```

Planner:

1. Validate both queries.
2. Reject or mark indeterminate for non-deterministic constructs.
3. Compare output schema.
4. Estimate scan cost.
5. If exact production comparison fits budget, run `EXCEPT ALL`.
6. Run plan comparison for cost/pruning regression.
7. Run read-path proof if assumptions exist.
8. If exact comparison exceeds budget and slices are allowed, use ephemeral
   local slice only when it increases evidence.
9. Otherwise return indeterminate with next action.

Default strategies:

- `production_exact`
- `production_explain`
- `production_bounded_probe`

### 13.3 Migration

Input:

```sql
ALTER TABLE events MODIFY COLUMN user_id UInt64
```

Planner:

1. Parse migration.
2. Reject compound or unsupported statements.
3. Classify operation.
4. Estimate rewrite footprint from metadata/system parts.
5. Generate read-only validation probes:
   - cast safety;
   - expression validity;
   - predicate match count;
   - affected parts/bytes.
6. If shadow execution is required and slices are allowed, use ephemeral local
   slice.
7. Otherwise return risk analysis plus explicit limits.

Migration language:

- Do say: “cast validated against current data.”
- Do say: “rewrite footprint estimated from current active parts.”
- Do not say: “migration is safe” unless a shadow execution path actually ran.

### 13.4 Repo Diff / PR

Input:

```bash
gozzle verify --changed
gozzle verify --diff origin/main...HEAD
```

Planner:

1. Detect changed files.
2. Classify query, migration, config, or unknown.
3. For changed query files:
   - find base version where available;
   - run query-pair verification;
   - fall back to single-query diagnosis if no base exists.
4. For migrations:
   - run migration planner.
5. For config changes:
   - validate table assumptions against live data.
6. Aggregate findings into one run report.

This should become the core CI/PR product.

## 14. Configuration

Current `gozzle.yaml` should evolve without requiring a large upfront schema.

Near-term config:

```yaml
version: 2

clickhouse:
  default_database: analytics

verification:
  production:
    allow_exact: true
    require_scope_for_exact: true
    max_execution_time_seconds: 30
    max_rows_to_read: 100000000
    max_bytes_to_read: 10GB

  local_slices:
    enabled: false
    default_mode: ephemeral
    max_slice_bytes: 2GB
    max_total_storage: 10GB
    persist_on_failure: false

policies:
  fail_on:
    - query_not_equivalent
    - cast_invalid
    - read_path_uniqueness_violated

  warn_on:
    - missing_partition_pruning
    - select_star
    - broad_join

tables:
  events:
    assumptions:
      unique_by:
        - event_id
```

Do not add semantic model config until the planner and unified result contract
are stable.

## 15. Safety Requirements

Hard rules:

- Never execute production mutations.
- Never run arbitrary user SQL as a write.
- Never create persistent local data without explicit permission.
- Never hide incomplete coverage.
- Never upgrade advisory findings into proof.
- Never send data to hosted services by default.

Production guardrails:

- `readonly=2`
- max execution time
- max result rows
- max rows/bytes to read
- max memory where supported
- audit entry
- generated query fingerprint

Local slice guardrails:

- explicit source scope;
- estimated size before export;
- max storage limit;
- PII warning if configured;
- cleanup lifecycle;
- audit entry;
- persist-on-failure option.

## 16. Output Examples

### 16.1 Query Rewrite Failure

```text
FAIL - Query rewrite changed results

Artifact:
queries/revenue_daily.sql

Evidence:
Exact multiset comparison found 291 additional rows in the new query.

Likely cause:
LEFT JOIN introduced multiple matches per account_id/date.

Other findings:
WARN - plan lost partition pruning on events.event_date

Coverage:
Checked current production data in configured scope.

Limits:
No local slice was created. Runtime latency was not proven.
```

### 16.2 Migration Warning

```text
WARN - Migration requires data rewrite

Artifact:
migrations/0042_modify_user_id.sql

Evidence:
Metadata analysis found 812 active parts and 1.2 TB affected.

Validation:
PASS - UInt64 cast validated against current data.

Limits:
gozzle did not execute the ALTER. Lock duration, replication lag, and merge
impact were not proven.
```

### 16.3 Dedup Failure

```text
FAIL - ReplacingMergeTree duplicates violate a uniqueness assumption

Table:
analytics.events

Assumption:
unique_by: [event_id]

Evidence:
Found 18,291 duplicate event_id groups in active parts.

Impact:
Queries reading this table without FINAL may overcount.
```

## 17. Implementation Plan

### Phase 0: Release Hygiene

Goal: make current repo releasable.

Tasks:

- Fix `npm run format:check`.
- Ensure `npm run lint`, `npm test`, and `npm run build` pass.
- Add root build/release gates for format, lint, tests, build, and MCP smoke.
- Fix website `metadataBase` warning.
- Update docs for migration correctness.

Exit criteria:

- All release commands pass locally and in CI.
- Public docs no longer overclaim.

### Phase 1: Unified Result Contract

Goal: make existing checks feel like one product without changing behavior.

Tasks:

- Define `VerificationRun`, `Finding`, `Limit`, `EvidenceLevel`, and `Coverage`.
- Map existing tool outputs into the contract:
  - `verify_equivalent`
  - `verify_dedup`
  - `diagnose_query`
  - `dry_run_migration`
  - read-path proof
- Update MCP structured output.
- Update `gozzle verify --json`.

Exit criteria:

- Every safety tool returns one top-level verdict.
- Every finding has evidence level, strategy, blocking flag, and limits.
- Agents no longer parse prose to decide pass/fail.

### Phase 2: Planner Skeleton

Goal: centralize artifact classification and check selection.

Tasks:

- Add artifact classifier.
- Add intent inference.
- Add capability detector.
- Add check registry.
- Add strategy selector.
- Add `gozzle verify --plan-only`.
- Route current `gozzle verify` through planner while preserving direct tools.

Exit criteria:

- `gozzle verify` produces a `VerificationRun`.
- Planner can explain skipped checks and selected strategies.
- Existing tests continue passing after migrated to new outputs.

### Phase 3: Query Rewrite As Hero Workflow

Goal: make query equivalence the clearest user-facing proof.

Tasks:

- Add `gozzle verify --before old.sql --after new.sql`.
- For `--changed` and `--diff`, find base file version from git.
- Run exact equivalence when possible.
- Run plan comparison.
- Run read-path proof.
- Return one combined report.

Exit criteria:

- A user can verify an AI query rewrite in one command.
- Result includes exact equivalence, plan risk, and assumption findings.

### Phase 4: Migration Planner

Goal: make migration risk/correctness output coherent and conservative.

Tasks:

- Route `dry_run_migration` through planner.
- Preserve current parser and read-only correctness checks.
- Add richer coverage rows checked/matched where available.
- Split gate reasons:
  - metadata-only pass;
  - rewrite warning;
  - correctness fail;
  - unsupported indeterminate.

Exit criteria:

- Migration reports never collapse rewrite estimate and correctness proof into
  one misleading verdict.
- CI JSON can distinguish rewrite review from correctness failure.

### Phase 5: Ephemeral Local Slice Escalation

Goal: make local verification a planner-owned backend, not a manual first-class
workflow.

Tasks:

- Add ephemeral slice lifecycle.
- Add `--with-slice`.
- Estimate copy size before export.
- Add cleanup in `finally`.
- Add orphan sweep.
- Add persist-on-failure option.
- Keep `create_local_slice` as advanced persistent workflow.

Exit criteria:

- Planner can safely use local slices for stronger evidence.
- Temporary data is cleaned by default.
- Public copy can honestly mention local shadow verification.

### Phase 6: PR/CI Product

Goal: make gozzle useful for teams.

Tasks:

- Add GitHub-friendly report format.
- Add PR comment output.
- Add policy severity controls.
- Add examples for GitHub Actions.
- Add historical local JSON records.

Exit criteria:

- Teams can run gozzle in CI and understand exactly what blocked a PR.

## 18. Launch Requirements

Minimum alpha release:

- current checks stable;
- docs honest;
- one-command install;
- MCP and CLI working;
- root README repositioned;
- at least one real red proof demo.

Minimum production release:

- unified result contract;
- planner skeleton;
- query rewrite hero workflow;
- migration correctness docs and JSON complete;
- real ClickHouse validation evidence;
- release gates clean.

## 19. Success Metrics

Alpha:

- 5-10 design partners run against real ClickHouse;
- at least one real bug caught per serious partner;
- users understand the difference between proof, warning, and indeterminate;
- agents can call the primary verification path without tool selection help.

Public OSS:

- installs;
- GitHub stars;
- MCP configured in real repos;
- `gozzle verify --changed` used in CI or hooks;
- inbound issues with real ClickHouse examples.

Commercial readiness:

- teams ask for PR comments, shared reports, history, policy, or audit;
- repeated usage across multiple developers in one org;
- users want central visibility rather than more local checks.

## 20. Final Recommendation

Build the planner before broadening database support.

The current codebase already has enough proof primitives to be useful. The next
product milestone should make those primitives feel like one verification
engine:

```text
Give gozzle a change.
gozzle decides how to prove what is safe.
gozzle returns a verdict with evidence and limits.
```

Stay ClickHouse-first until this experience is sharp. Do not add Postgres,
DuckDB, dbt, semantic models, or hosted control plane before the planner,
verdict contract, and query rewrite workflow are coherent.
