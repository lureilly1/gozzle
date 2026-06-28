# gozzle Implementation Handoff Plan

This document turns the PRD and release-readiness review into a task-by-task
implementation plan. It is written for a future model or engineer with no prior
conversation context.

## Product Direction To Implement

gozzle should move from a set of separate ClickHouse tools to a planner-led
verification engine.

Current shape:

- `diagnose_query`
- `verify_equivalent`
- `verify_dedup`
- read-path proof
- `dry_run_migration`
- `create_local_slice`
- `gozzle verify`

Target shape:

```text
Artifact -> classify -> plan -> execute checks -> evidence -> verdict
```

Primary user-facing promise:

> Your AI changed ClickHouse SQL. gozzle proves what can be proven, checks what
> can be checked, and clearly labels what remains uncertain.

Primary product surface:

- CLI: `gozzle verify`
- MCP: `verify_artifact`

The existing lower-level tools should remain as expert/debug surfaces, but users
and agents should not need to manually compose them.

## Current Code Map

Core package:

- `packages/cli`

Important files:

- CLI entrypoint: `packages/cli/src/cli.ts`
- MCP server: `packages/cli/src/mcp/server.ts`
- Verify command: `packages/cli/src/commands/verify.ts`
- Query diagnosis: `packages/cli/src/clickhouse/query-diagnosis.ts`
- Query equivalence: `packages/cli/src/clickhouse/equivalent.ts`
- Dedup proof: `packages/cli/src/clickhouse/dedup.ts`
- Read-path proof: `packages/cli/src/commands/verify-read-path.ts`
- Migration parser: `packages/cli/src/clickhouse/migration-parser.ts`
- Migration engine: `packages/cli/src/clickhouse/migration.ts`
- Migration MCP formatter: `packages/cli/src/tools/dry-run-migration.ts`
- Local slices: `packages/cli/src/local-engine/`
- Guardrails: `packages/cli/src/config/guardrails.ts`
- Project config: `packages/cli/src/config/project.ts`
- Current verdict helper: `packages/cli/src/shared/verdict.ts`
- Web docs: `apps/web/content/docs/`
- Homepage: `apps/web/app/(home)/page.tsx`

Existing docs added during review:

- `GOZZLE_PRD.md`
- `PRODUCT_SURFACE_REVIEW.md`
- `RELEASE_READINESS_CHECKLIST.md`

## Ground Rules

- Pre-release: breaking changes are allowed.
- Do not broaden beyond ClickHouse until planner + unified verdicts are working.
- Do not claim full migration safety unless a shadow execution path actually
  runs.
- Prefer exact/source proof where safe.
- Prefer production read-only checks before local copying.
- Local slices should be an escalation backend, not the default hero workflow.
- No production writes, mutations, DDL, or arbitrary user SQL execution.

## Target Release Gates

Before any production-style release, these should pass:

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run smoke:mcp -w @gozzle/cli
npm run test:integration -w @gozzle/cli
```

At the time of review:

- `npm test` passed.
- `npm run build` passed.
- `npm run lint` passed.
- `npm run format:check` failed on migration files.
- `npm run build` emitted a web `metadataBase` warning.

## Phase 0: Release Hygiene And Docs

Goal: make the current repo clean and honest before deeper refactors.

### Task 0.1 Fix Formatting

Files currently reported by `npm run format:check`:

- `packages/cli/src/clickhouse/migration-parser.ts`
- `packages/cli/src/clickhouse/migration.ts`
- `packages/cli/tests/migration-parser.test.ts`
- `packages/cli/tests/migration.test.ts`

Commands:

```bash
npm run format
npm run format:check
npm run lint
npm test
npm run build
```

Acceptance:

- [x] `format:check` exits 0.
- [x] No behavior changes.

### Task 0.2 Fix Web Metadata Warning

Problem:

`npm run build` warns that `metadataBase` is missing and falls back to
`http://localhost:3000`.

Likely files:

- `apps/web/app/layout.tsx`
- `apps/web/lib/shared.ts`

Implementation sketch:

```ts
// apps/web/app/layout.tsx
import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://gozzle.dev";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "gozzle",
    template: "%s | gozzle"
  },
  description: "Agent verification layer for ClickHouse changes"
};
```

Acceptance:

- [x] `npm run build` exits 0 without `metadataBase` warning.

### Task 0.3 Update Migration Docs

Primary docs:

- `apps/web/content/docs/dry-run-migration.mdx`
- `packages/cli/README.md`
- `CHANGELOG.md`

Must document:

- Predicate is evaluated read-only against current data.
- UPDATE assignments are evaluated and cast to target column type.
- `MODIFY COLUMN` validates current values against proposed type.
- `ADD/MODIFY COLUMN ... DEFAULT|MATERIALIZED expr` validates expression output.
- Subqueries and external-access functions are blocked.
- Rewrite estimate and correctness findings are separate.
- The tool does not execute the production ALTER.
- The tool does not prove lock duration, merge timing, replication lag, or full
  migration safety.

Acceptance:

- [x] Docs include “Read-only correctness gate.”
- [x] Docs do not say “migration correct” unless referring to future shadow
  execution.

### Task 0.4 Fix Hero Positioning

Primary files:

- `apps/web/app/(home)/page.tsx`
- `apps/web/content/docs/index.mdx`
- `README.md`

Recommended homepage H1:

```text
Your AI changed ClickHouse SQL. gozzle proves whether it is safe.
```

Recommended subhead:

```text
gozzle runs bounded, read-only checks against your real ClickHouse schema and
current data, catching duplicate reads, bad query rewrites, unsafe casts, and
mutation blast radius before they ship.
```

Replace any generic “verified correct” copy in the homepage diagram with one of:

- `proof returned`
- `verified`
- `safe / review / caught`

Acceptance:

- [x] Website leads with agent verification, not “developer toolkit.”
- [x] Copy does not overclaim for advisory/dry-run checks.

### Task 0.5 Add Quality Gates To CI

Primary files:

- `.github/workflows/build.yml`
- `.github/workflows/publish-canary.yml`
- `.github/workflows/release.yml`

Add steps:

```yaml
- name: Format check
  run: npm run format:check

- name: Lint
  run: npm run lint

- name: MCP smoke
  run: npm run smoke:mcp -w @gozzle/cli
```

Acceptance:

- [x] Build, canary, and release workflows enforce format/lint/test/build.

## Phase 1: Unified Verification Result Contract

Goal: make current checks return one common structure without changing their
core behavior yet.

### Task 1.1 Replace/Extend Shared Verdict Types

Current file:

- `packages/cli/src/shared/verdict.ts`

Create or replace with:

```ts
export type Verdict = "pass" | "fail" | "warn" | "indeterminate";

export type EvidenceLevel =
  | "exact"
  | "bounded"
  | "metadata"
  | "explain"
  | "sampled"
  | "advisory";

export type VerificationStrategy =
  | "static_parse"
  | "metadata_only"
  | "production_explain"
  | "production_bounded_probe"
  | "production_exact"
  | "local_slice_exact"
  | "local_slice_simulation"
  | "advisory";

export type FindingCategory =
  | "correctness"
  | "cost"
  | "performance"
  | "semantic"
  | "migration"
  | "governance"
  | "coverage";

export interface Limit {
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

export interface Evidence {
  label: string;
  value: string | number | boolean | null;
}

export interface Finding {
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

export interface CoverageSummary {
  scope: "table" | "partition" | "predicate" | "metadata" | "query" | "unknown";
  rowsChecked?: number;
  rowsMatched?: number;
  bytesChecked?: number;
  note?: string;
}

export interface ArtifactSummary {
  type: "query" | "query_pair" | "migration" | "repo_diff" | "table_assumption" | "unknown";
  source: "cli" | "mcp" | "ci" | "hook";
  path?: string;
  fingerprint: string;
}

export interface VerificationPlanSummary {
  selectedStrategies: VerificationStrategy[];
  skippedStrategies: Array<{ strategy: VerificationStrategy; reason: string }>;
  executedChecks: string[];
}

export interface VerificationRun {
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
  recommendations: string[];
  productionExecuted: false;
}
```

Add helper:

```ts
export function aggregateVerdict(findings: Finding[], limits: Limit[] = []): Verdict {
  if (findings.some((finding) => finding.blocking && finding.severity === "error")) {
    return "fail";
  }
  if (limits.some((limit) => limit.type === "budget" || limit.type === "permissions")) {
    return "indeterminate";
  }
  if (findings.some((finding) => finding.severity === "warn" || finding.verdict === "warn")) {
    return "warn";
  }
  return "pass";
}
```

Acceptance:

- [x] Existing tests compile after imports are adjusted.
- [x] `verify_equivalent` can still map to exit code semantics.

### Task 1.2 Add Adapter For Query Equivalence

Current file:

- `packages/cli/src/clickhouse/equivalent.ts`

Do not rewrite internals first. Add adapter function in new file:

- `packages/cli/src/planner/adapters/equivalent.ts`

Example:

```ts
import type { VerifyEquivalentResult } from "../../clickhouse/equivalent.js";
import type { Finding, VerificationRun } from "../../shared/verdict.js";
import { fingerprint } from "../../shared/fingerprint.js";

export function equivalentToRun(
  result: VerifyEquivalentResult,
  artifact: { left: string; right: string; source: "cli" | "mcp" | "ci" | "hook" }
): VerificationRun {
  const findings: Finding[] = [];

  if (result.verdict === "incorrect") {
    findings.push({
      id: result.shapeMismatch ? "query_shape_mismatch" : "query_not_equivalent",
      title: result.shapeMismatch ? "Query result shape changed" : "Query result changed",
      severity: "error",
      verdict: "fail",
      category: "correctness",
      evidenceLevel: "exact",
      strategy: "production_exact",
      message: result.shapeMismatch
        ? "The two queries return different column shapes."
        : `Exact comparison found ${result.differingRows} differing row(s).`,
      evidence: [
        { label: "leftOnly", value: result.leftOnly },
        { label: "rightOnly", value: result.rightOnly }
      ],
      limits: [],
      blocking: true
    });
  }

  if (result.verdict === "indeterminate") {
    return {
      runId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      artifact: {
        type: "query_pair",
        source: artifact.source,
        fingerprint: fingerprint(`${artifact.left}\n---\n${artifact.right}`)
      },
      verdict: "indeterminate",
      severity: "warn",
      confidence: "advisory",
      confidenceByCategory: { correctness: "advisory" },
      coverage: { scope: "unknown", note: result.indeterminateReason },
      plan: {
        selectedStrategies: ["production_exact"],
        skippedStrategies: [],
        executedChecks: ["query_equivalence"]
      },
      findings: [],
      limits: [
        {
          type: "budget",
          message: result.indeterminateReason ?? "Equivalence could not be proven."
        }
      ],
      recommendations: ["Add matching filters to both queries or compare a narrower scope."],
      productionExecuted: false
    };
  }

  return {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    artifact: {
      type: "query_pair",
      source: artifact.source,
      fingerprint: fingerprint(`${artifact.left}\n---\n${artifact.right}`)
    },
    verdict: findings.length > 0 ? "fail" : "pass",
    severity: findings.length > 0 ? "error" : "none",
    confidence: "exact",
    confidenceByCategory: { correctness: "exact" },
    coverage: { scope: "query", note: "Exact multiset comparison in ClickHouse." },
    plan: {
      selectedStrategies: ["production_exact"],
      skippedStrategies: [],
      executedChecks: ["query_equivalence"]
    },
    findings,
    limits: [],
    recommendations: [],
    productionExecuted: false
  };
}
```

Acceptance:

- [x] `verify_equivalent` MCP can expose both legacy structured fields and new
  `verificationRun`.
- [x] No behavior change to direct command yet.

### Task 1.3 Add Adapter For Migration

Current files:

- `packages/cli/src/clickhouse/migration.ts`
- `packages/cli/src/tools/dry-run-migration.ts`

New file:

- `packages/cli/src/planner/adapters/migration.ts`

Mapping rules:

- `parsed.classification === "unsupported"` -> `indeterminate`
- any correctness finding with `status === "error"` -> `fail`
- metadata-only and no correctness errors -> `pass`
- part-rewriting/risky and no correctness errors -> `warn`

Example:

```ts
import type { DryRunMigrationResult } from "../../clickhouse/migration.js";
import type { Finding, VerificationRun } from "../../shared/verdict.js";
import { fingerprint } from "../../shared/fingerprint.js";

export function migrationToRun(
  result: DryRunMigrationResult,
  source: "cli" | "mcp" | "ci" | "hook",
  path?: string
): VerificationRun {
  const findings: Finding[] = [];

  for (const item of result.correctness) {
    findings.push({
      id: `migration_${item.check}`,
      title: item.check,
      severity: item.status === "error" ? "error" : item.status === "warning" ? "warn" : "info",
      verdict: item.status === "error" ? "fail" : "pass",
      category: "migration",
      evidenceLevel: "bounded",
      strategy: "production_bounded_probe",
      message: item.message,
      evidence: [{ label: "check", value: item.check }],
      limits: [],
      blocking: item.status === "error"
    });
  }

  if (result.parsed.classification === "unsupported") {
    return base("indeterminate", "warn", [
      {
        type: "unsupported_syntax",
        message: result.parsed.reason
      }
    ]);
  }

  if (result.rewrite.evidence !== "none" && result.rewrite.affectedParts > 0) {
    findings.push({
      id: "migration_rewrite_footprint",
      title: "Migration may rewrite data parts",
      severity: "warn",
      verdict: "warn",
      category: "migration",
      evidenceLevel: "metadata",
      strategy: "metadata_only",
      message: `${result.rewrite.affectedParts} active part(s), ${result.rewrite.affectedPartRows} row(s), ${result.rewrite.affectedBytes} compressed byte(s) may be rewritten.`,
      evidence: [
        { label: "affectedParts", value: result.rewrite.affectedParts },
        { label: "affectedPartRows", value: result.rewrite.affectedPartRows },
        { label: "affectedBytes", value: result.rewrite.affectedBytes },
        { label: "rewriteEvidence", value: result.rewrite.evidence }
      ],
      limits: [
        {
          type: "advisory_only",
          message: "gozzle did not execute the ALTER and does not prove lock duration, replication lag, or merge impact."
        }
      ],
      blocking: false
    });
  }

  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarn = findings.some((finding) => finding.severity === "warn");
  return base(hasError ? "fail" : hasWarn ? "warn" : "pass", hasError ? "error" : hasWarn ? "warn" : "none", []);

  function base(
    verdict: VerificationRun["verdict"],
    severity: VerificationRun["severity"],
    limits: VerificationRun["limits"]
  ): VerificationRun {
    return {
      runId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      artifact: {
        type: "migration",
        source,
        path,
        fingerprint: fingerprint(result.parsed.statement)
      },
      verdict,
      severity,
      confidence: verdict === "pass" ? "bounded" : "metadata",
      confidenceByCategory: { migration: "bounded" },
      coverage: {
        scope: result.parsed.predicate ? "predicate" : "metadata",
        rowsMatched: result.rewrite.matchingRows,
        bytesChecked: result.rewrite.affectedBytes
      },
      plan: {
        selectedStrategies: ["metadata_only", "production_bounded_probe"],
        skippedStrategies: [],
        executedChecks: ["migration_blast_radius", "migration_correctness"]
      },
      findings,
      limits,
      recommendations: [result.parsed.advice],
      productionExecuted: false
    };
  }
}
```

Acceptance:

- [x] Migration JSON can distinguish correctness failure from rewrite warning.
- [x] No “migration correct” output from metadata-only rewrite estimates.

### Task 1.4 Add Adapters For Query Diagnosis And Dedup

New files:

- `packages/cli/src/planner/adapters/diagnosis.ts`
- `packages/cli/src/planner/adapters/dedup.ts`

Mapping:

Query diagnosis:

- proven high/medium -> `warn` or `fail` depending strict/policy
- advisory -> `warn`, non-blocking
- evidence level: `explain` for EXPLAIN findings, `advisory` for static query
  shape findings

Dedup:

- duplicate rows > 0 -> `fail`
- scan skipped -> `indeterminate`
- ineligible -> `indeterminate` or `warn`, depending context
- evidence level: `exact`
- strategy: `production_exact`

Acceptance:

- [x] `verify_dedup` and `diagnose_query` have `verificationRun` structured output.

## Phase 2: Planner Skeleton

Goal: route artifacts through a central planner while preserving existing direct
commands/tools.

### Task 2.1 Add Planner Directory

Create:

```text
packages/cli/src/planner/
  artifacts.ts
  capabilities.ts
  checks.ts
  planner.ts
  types.ts
  adapters/
```

Status:

- [x] Planner directory and skeleton files added.

### Task 2.2 Artifact Classification

File:

- `packages/cli/src/planner/artifacts.ts`

Implementation sketch:

```ts
import { detectStatementKind, normalizeSqlFile } from "../clickhouse/statement.js";

export type ArtifactInput =
  | { source: "content"; content: string; path?: string }
  | { source: "query_pair"; left: string; right: string; path?: string };

export interface ClassifiedArtifact {
  type: "query" | "query_pair" | "migration" | "unknown";
  statement?: string;
  left?: string;
  right?: string;
  path?: string;
  reason?: string;
}

export function classifyArtifact(input: ArtifactInput): ClassifiedArtifact {
  if (input.source === "query_pair") {
    return { type: "query_pair", left: input.left, right: input.right, path: input.path };
  }

  const statement = normalizeSqlFile(input.content);
  const kind = detectStatementKind(statement);
  if (kind === "query") return { type: "query", statement, path: input.path };
  if (kind === "migration") return { type: "migration", statement, path: input.path };
  return { type: "unknown", statement, path: input.path, reason: "Not a supported SELECT/WITH or ALTER statement." };
}
```

Tests:

- `packages/cli/tests/planner-artifacts.test.ts`

Status:

- [x] Artifact classification implemented.
- [x] Planner artifact tests added.

### Task 2.3 Capability Detection

File:

- `packages/cli/src/planner/capabilities.ts`

Keep simple initially:

```ts
export type Capability =
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

export interface CapabilitySet {
  available: Set<Capability>;
  missing: Array<{ capability: Capability; reason: string }>;
}
```

Initial implementation can be static based on config and known command context.
Do not over-engineer.

Status:

- [x] Static capability detection added for initial planner context.

### Task 2.4 Check Registry

File:

- `packages/cli/src/planner/checks.ts`

Types:

```ts
import type { Finding, VerificationStrategy } from "../shared/verdict.js";
import type { ClassifiedArtifact } from "./artifacts.js";

export type VerificationIntent =
  | "correctness"
  | "equivalence"
  | "cost_risk"
  | "read_path_safety"
  | "dedup_safety"
  | "migration_risk";

export interface PlannerContext {
  artifact: ClassifiedArtifact;
  defaultDatabase: string;
  strict: boolean;
}

export interface CheckEstimate {
  checkId: string;
  strategies: VerificationStrategy[];
  shouldRun: boolean;
  reason?: string;
}

export interface CheckDefinition {
  id: string;
  intents: VerificationIntent[];
  supports(context: PlannerContext): boolean;
  estimate(context: PlannerContext): CheckEstimate;
  execute(context: PlannerExecutionContext): Promise<Finding[]>;
}
```

Initial registry should wrap existing checks:

- query diagnosis
- migration dry-run
- query equivalence
- read-path proof

Dedup remains direct until table assumptions/check context is ready.

Status:

- [x] Initial check registry added for query diagnosis, query equivalence, and
  migration risk.
- [x] Registry is planning-only while execution remains direct-dispatched.

### Task 2.5 Planner Execution

File:

- `packages/cli/src/planner/planner.ts`

Sketch:

```ts
import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import type { VerificationRun } from "../shared/verdict.js";
import { classifyArtifact, type ArtifactInput } from "./artifacts.js";

export interface PlanOptions {
  defaultDatabase: string;
  source: "cli" | "mcp" | "ci" | "hook";
  strict?: boolean;
  planOnly?: boolean;
  allowLocalSlice?: boolean;
  path?: string;
}

export async function verifyArtifact(
  client: ClickHouseMetadataClient,
  input: ArtifactInput,
  options: PlanOptions
): Promise<VerificationRun> {
  const artifact = classifyArtifact(input);

  if (artifact.type === "unknown") {
    return unknownArtifactRun(artifact, options);
  }

  // First version may dispatch directly by artifact type.
  // Later versions should use registry estimates.
  if (artifact.type === "migration") {
    // call dryRunMigration and migrationToRun
  }

  if (artifact.type === "query") {
    // call diagnoseQuery, read-path proof if config passed later, diagnosisToRun
  }

  if (artifact.type === "query_pair") {
    // call verifyEquivalent and equivalentToRun
  }
}
```

Acceptance:

- [x] One function can verify query, query pair, and migration.
- [x] Direct commands continue working.
- [x] Tests cover dispatch.

## Phase 3: Update CLI `gozzle verify`

Goal: make `gozzle verify` planner-led.

### Task 3.1 Extend CLI Args

Current file:

- `packages/cli/src/commands/verify.ts`

Add options:

```ts
export interface VerifyOptions {
  strict: boolean;
  json: boolean;
  changed: boolean;
  all: boolean;
  planOnly: boolean;
  withSlice: boolean;
  before?: string;
  after?: string;
  diff?: string;
}
```

Parse:

```bash
gozzle verify --before old.sql --after new.sql
gozzle verify --plan-only file.sql
gozzle verify --with-slice file.sql
```

Acceptance:

- [x] Usage error if only one of `--before`/`--after` is supplied.
- [x] `--before/--after` cannot be combined with positional files.

### Task 3.2 Route Single Files Through Planner

Current `verifyFile` manually dispatches query/migration.

Replace internals with:

```ts
const run = await verifyArtifact(
  client,
  { source: "content", content: statement, path: file },
  {
    defaultDatabase,
    source: "cli",
    strict: options.strict,
    planOnly: options.planOnly,
    allowLocalSlice: options.withSlice,
    path: file
  }
);
```

Map to existing `FileOutcome` or replace `FileOutcome` with `VerificationRun`.
Since breaking changes are allowed, prefer replacing JSON output with
`VerificationRun[]`.

Human output should summarize:

```text
FAIL - Query rewrite changed results
file.sql

Findings:
- [error] query_not_equivalent: ...

Limits:
- ...
```

Acceptance:

- [x] Existing tests updated to new JSON shape.
- [x] Exit code logic uses `VerificationRun.verdict`.

### Task 3.3 Query Pair CLI

In `runVerifyCommand`, if `options.before && options.after`:

```ts
const [left, right] = await Promise.all([
  readFile(options.before, "utf8"),
  readFile(options.after, "utf8")
]);
const run = await verifyArtifact(
  client,
  { source: "query_pair", left, right, path: `${options.before}...${options.after}` },
  { defaultDatabase, source: "cli", strict: options.strict }
);
```

Acceptance:

- [x] `gozzle verify --before a.sql --after b.sql --json` returns one
  `VerificationRun`.
- [x] Exit 0 on pass, 1 on fail/warn according to strict policy, 2 on operational
  error.

### Task 3.4 Git Diff Before/After

Current git helpers:

- `packages/cli/src/commands/verify-git.ts`

Add helper:

```ts
export async function readFileAtRef(ref: string, path: string): Promise<string | undefined> {
  // Use `git show ${ref}:${path}` non-interactively.
  // Return undefined for added files.
}
```

For `--diff` and changed files:

- If file exists in base and head and both are queries, run query-pair planner.
- If added query, run single-query planner.
- If migration, run migration planner.

Acceptance:

- [x] Changed query rewrites get equivalence check automatically.

## Phase 4: Add MCP `verify_artifact`

Goal: agents call one main verification tool.

### Task 4.1 Implement Tool

New file:

- `packages/cli/src/tools/verify-artifact.ts`

Sketch:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyArtifact } from "../planner/planner.js";
import { runAuditedTool } from "../shared/audit.js";
import { withClickHouseTool } from "./with-clickhouse.js";

export function createVerifyArtifactTool(server: McpServer): void {
  server.registerTool(
    "verify_artifact",
    {
      title: "Verify ClickHouse Artifact",
      description:
        "Classify a ClickHouse query or migration, choose the strongest safe verification plan, and return a verdict with evidence and limits.",
      inputSchema: {
        content: z.string().min(1),
        artifactType: z.enum(["auto", "query", "migration"]).default("auto"),
        path: z.string().optional(),
        allowLocalSlice: z.boolean().default(false)
      }
    },
    async ({ content, path, allowLocalSlice }) =>
      runAuditedTool("verify_artifact", { path, artifactSha256: fingerprint(content) }, () =>
        withClickHouseTool(async (client, config) => {
          const run = await verifyArtifact(
            client,
            { source: "content", content, path },
            {
              defaultDatabase: config.database ?? "default",
              source: "mcp",
              allowLocalSlice
            }
          );
          return {
            content: [{ type: "text", text: formatVerificationRun(run) }],
            structuredContent: run
          };
        }, (error) => `gozzle could not verify the artifact.\n\n${errorMessage(error)}`)
      )
  );
}
```

Remember to register in:

- `packages/cli/src/mcp/server.ts`

Acceptance:

- [x] MCP smoke test sees `verify_artifact`.
- [x] Existing direct MCP tools remain.

### Task 4.2 Update Agent Skill

File:

- `packages/cli/src/init/agent-skill.ts`

Instruction should say:

- Call `verify_artifact` first for SQL changes.
- Use focused tools only when more context is needed.
- Report proof, warnings, unsupported checks, and limits separately.

Acceptance:

- [x] Skill no longer asks agents to manually choose low-level tools first.

## Phase 5: Planner-Aware Docs And Website

### Task 5.1 Root README Rewrite

File:

- `README.md`

Structure:

1. Hero line.
2. Install.
3. First check.
4. What it catches.
5. CLI and MCP surfaces.
6. Read-only guarantee.
7. Development.

Acceptance:

- [x] New user can understand and try gozzle from root README.

### Task 5.2 Docs Add Planner Page

New page:

- `apps/web/content/docs/verification-planner.mdx`

Include:

- artifact -> planner -> verdict flow;
- evidence levels;
- strategies;
- when local slices are used;
- limits and non-goals.

Update:

- `apps/web/content/docs/meta.json`

Status:

- [x] Planner page added and linked in docs navigation.

### Task 5.3 Claims And Limits Page

New page:

- `apps/web/content/docs/claims-and-limits.mdx`

Include:

- exact vs bounded vs metadata vs EXPLAIN vs advisory;
- what “pass” means;
- why `dry_run_migration` is not full shadow execution;
- what gozzle never proves.

Status:

- [x] Claims and limits page added and linked in docs navigation.

## Phase 6: Integration Tests

### Task 6.1 Migration Correctness Integration

Current integration directory:

- `packages/cli/tests/integration/`

Add test file:

- `packages/cli/tests/integration/migration-correctness.integration.test.ts`

Test setup:

```sql
CREATE TABLE default.gozzle_migration_test
(
  id UInt64,
  raw String,
  status String
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO default.gozzle_migration_test VALUES
(1, '123', 'new'),
(2, 'not-a-number', 'new');
```

Cases:

- `ALTER TABLE gozzle_migration_test MODIFY COLUMN raw UInt64` should produce
  correctness failure.
- `ALTER TABLE gozzle_migration_test UPDATE status = concat(status, '-done') WHERE id = 1`
  should produce correctness pass and rewrite warning.

Acceptance:

- [x] Integration proves read-only correctness behavior against real ClickHouse
  when a ClickHouse server is configured; skips cleanly otherwise.

### Task 6.2 Planner Integration

Add integration or unit tests for:

- `verify_artifact` query dispatch;
- migration dispatch;
- query pair dispatch;
- unsupported artifact returns indeterminate.

Status:

- [x] Planner unit tests cover query, migration, query pair, plan-only, and
  unsupported artifact dispatch.

## Phase 7: Ephemeral Local Slice Escalation

Do this only after phases 0-6.

### Task 7.1 Add Ephemeral Slice Config

File:

- `packages/cli/src/config/local-slice.ts`

Add:

```ts
export interface EphemeralSliceConfig {
  enabled: boolean;
  rootDirectory: string;
  persistOnFailure: boolean;
  cleanupAfterMinutes: number;
}
```

Status:

- [x] Ephemeral slice config and environment parsing added.

### Task 7.2 Add Ephemeral Slice Runner

New file:

- `packages/cli/src/local-engine/ephemeral-slice.ts`

Behavior:

- create temp workspace under `~/.gozzle/tmp`;
- run verification;
- cleanup in `finally`;
- optionally persist on failure;
- audit path and byte size, not row content.

Sketch:

```ts
export async function withEphemeralSlice<T>(
  options: EphemeralSliceOptions,
  run: (slice: LocalSliceResult) => Promise<T>
): Promise<T> {
  let result: LocalSliceResult | undefined;
  try {
    result = await createLocalSlice(...);
    return await run(result);
  } catch (error) {
    if (options.persistOnFailure) throw error;
    throw error;
  } finally {
    if (result && !options.persistOnFailure) {
      await rm(result.workspacePath, { recursive: true, force: true });
    }
  }
}
```

Acceptance:

- [x] No temporary slice remains after success.
- [x] Failure persistence is opt-in.

## Phase 8: PR/CI Product

Do this after planner core is stable.

### Task 8.1 GitHub Report Format

Add option:

```bash
gozzle verify --diff origin/main...HEAD --format github
```

Output Markdown:

```md
## gozzle verification

**Verdict:** FAIL

| File | Verdict | Findings |
| --- | --- | --- |
| queries/revenue.sql | FAIL | query_not_equivalent |

### Findings

...
```

Status:

- [x] `gozzle verify --diff origin/main...HEAD --format github` added.
- [x] Markdown summary includes verdict, file table, findings, and limits.

### Task 8.2 GitHub Actions Example

Add docs:

- `apps/web/content/docs/ci.mdx`

Include:

```yaml
- run: npx gozzle verify --diff origin/main...HEAD --json
```

Later:

- PR comment action.

Status:

- [x] `apps/web/content/docs/ci.mdx` added with a GitHub Actions example.
- [x] PR comment action remains a later integration.

## Suggested Execution Order

1. Phase 0: hygiene/docs.
2. Phase 1: result contract and adapters.
3. Phase 2: planner skeleton.
4. Phase 3: route CLI verify through planner.
5. Phase 4: MCP `verify_artifact`.
6. Phase 5: docs/site.
7. Phase 6: integration tests.
8. Phase 7: ephemeral slices.
9. Phase 8: PR/CI product.

Do not start Phase 7 or Phase 8 until the planner contract is stable.

## Test Matrix

Run after each phase:

```bash
npm run format:check
npm run lint
npm test
npm run build
```

Run before release:

```bash
npm run smoke:mcp -w @gozzle/cli
npm run test:integration -w @gozzle/cli
```

Expected unit additions:

- `packages/cli/tests/planner-artifacts.test.ts`
- `packages/cli/tests/planner.test.ts`
- `packages/cli/tests/verify-artifact.test.ts`
- `packages/cli/tests/structured-output.test.ts` updates
- `packages/cli/tests/verify-command.test.ts` updates
- `packages/cli/tests/integration/migration-correctness.integration.test.ts`

## Breaking Changes Allowed

Because gozzle is pre-release, prefer clean contracts over backwards-compatible
awkwardness.

Acceptable breaking changes:

- `gozzle verify --json` output shape changes to `VerificationRun[]`.
- MCP structured output adds a top-level verification contract.
- `gozzle.yaml` may gain `version: 2`.
- Agent skill instructions may be rewritten around `verify_artifact`.

Avoid breaking:

- `gozzle equivalent <a> <b>` command should keep working.
- Existing direct MCP tools should remain during transition.
- Read-only guarantees must not weaken.

## Definition Of Done For Planner V1

- `gozzle verify file.sql` returns a `VerificationRun`.
- `gozzle verify --before old.sql --after new.sql` runs equivalence through the
  planner.
- `gozzle verify --changed` can verify changed files through the planner.
- MCP exposes `verify_artifact`.
- Existing low-level tools still work.
- Every finding has:
  - id;
  - severity;
  - verdict;
  - evidence level;
  - strategy;
  - blocking flag;
  - limits.
- Docs explain proof vs advisory vs indeterminate.
- Tests, lint, format, and build pass.
