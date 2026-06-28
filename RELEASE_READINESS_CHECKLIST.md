# gozzle Release Readiness Checklist

This checklist closes the gaps found in the top-down review of gozzle as an
agent verification layer for ClickHouse. Treat this as the release driver for a
production-quality public launch, not as internal strategy notes.

## Release Target

**Hero positioning:** agent-native, read-only verification for ClickHouse
changes.

Recommended public line:

> Your AI changed ClickHouse SQL. gozzle proves whether it is safe.

Recommended category:

> Agent verification layer for ClickHouse changes.

Use “proves” only where the tool returns an exact or live-data-backed result.
Use “reviews,” “estimates,” or “flags” where the result is advisory,
impact-only, or unsupported.

## P0: Release Blockers

- [ ] Fix current formatting failures.
  - Run: `npm run format:check`
  - Current failing files:
    - `packages/cli/src/clickhouse/migration-parser.ts`
    - `packages/cli/src/clickhouse/migration.ts`
    - `packages/cli/tests/migration-parser.test.ts`
    - `packages/cli/tests/migration.test.ts`
  - Implementation:
    - Run `npm run format`.
    - Re-run `npm run format:check`.
  - Acceptance:
    - `npm run format:check` exits 0.
    - `npm run lint`, `npm test`, and `npm run build` still pass.

- [ ] Update migration dry-run documentation to match the new read-only
      correctness gate.
  - Primary docs:
    - `apps/web/content/docs/dry-run-migration.mdx`
    - `packages/cli/README.md`
    - `CHANGELOG.md`
  - Implementation references:
    - Correctness result types:
      `packages/cli/src/clickhouse/migration.ts`
    - Parser metadata:
      `packages/cli/src/clickhouse/migration-parser.ts`
    - Formatted + structured output:
      `packages/cli/src/tools/dry-run-migration.ts`
  - Document these checks:
    - Predicate is evaluated read-only against current data.
    - UPDATE assignments are evaluated and cast to the existing target column
      type.
    - `MODIFY COLUMN` casts current values to the proposed target type.
    - `ADD/MODIFY COLUMN ... DEFAULT|MATERIALIZED expr` expressions are
      evaluated read-only and cast to their declared type.
    - Subqueries and external-access functions are blocked in validation reads.
    - Verdict wording must say “proven against current data,” not “migration is
      globally correct.”
  - Acceptance:
    - Example output includes the “Read-only correctness gate” section.
    - Docs clearly separate rewrite estimate from correctness findings.
    - Docs do not imply local chDB shadow execution for migrations exists yet.

- [ ] Fix website build metadata warning.
  - Current warning from `npm run build`:
    - `metadataBase property in metadata export is not set`
  - Likely files:
    - `apps/web/app/layout.tsx`
    - `apps/web/lib/shared.ts`
  - Implementation:
    - Add production `metadataBase`, preferably from an environment variable
      with a stable fallback.
    - Ensure OG and Twitter image URLs resolve to the public site URL.
  - Acceptance:
    - `npm run build` exits 0 with no metadataBase warning.

- [ ] Tighten homepage hero claims.
  - Primary files:
    - `apps/web/app/(home)/page.tsx`
    - `apps/web/content/docs/index.mdx`
  - Current issue:
    - Diagram says “verified correct,” but not every gozzle check returns
      exact `correct`.
  - Implementation:
    - Replace “verified correct” with wording such as:
      - “verified”
      - “proof returned”
      - “safe / review / caught”
    - Keep the H1 oriented around AI-generated ClickHouse changes.
    - Avoid “migration correct” unless referring to a specific exact check.
  - Acceptance:
    - Homepage communicates the product as an agent verification layer, not a
      generic ClickHouse toolkit.
    - Hero copy does not overclaim for dry-run or advisory checks.

## P1: Product Contract And Agent Output

- [ ] Define one top-level verdict contract across all checks.
  - Existing reference:
    - `packages/cli/src/shared/verdict.ts`
    - `packages/cli/src/clickhouse/equivalent.ts`
  - Current inconsistency:
    - `verify_equivalent`: `correct | incorrect | indeterminate`
    - `diagnose_query`: `proven | advisory` findings
    - `dry_run_migration`: `correctnessStatus`
    - `gozzle verify`: boolean `failing`
  - Proposed shared contract:
    ```ts
    type Verdict = "correct" | "incorrect" | "review" | "indeterminate";
    type Method = "exact-source" | "read-only-live-data" | "metadata-estimate" | "advisory";
    interface Coverage {
      scope: "table" | "partition" | "predicate" | "metadata" | "unknown";
      rowsChecked?: number;
      rowsMatched?: number;
      note?: string;
    }
    ```
  - Implementation tasks:
    - Extend or replace `packages/cli/src/shared/verdict.ts`.
    - Add adapter functions per tool rather than rewriting internals all at
      once.
    - Ensure MCP structured outputs expose `verdict`, `method`, and `coverage`.
  - Acceptance:
    - Every MCP tool with a safety outcome has a top-level verdict.
    - No sampled or partial result can return `correct`.
    - Agents can decide pass/review/fail without parsing prose.

- [ ] Improve `gozzle verify` migration JSON and exit semantics.
  - Primary file:
    - `packages/cli/src/commands/verify.ts`
  - Current behavior:
    - Any non-`metadata-only` migration fails the gate.
    - JSON omits migration correctness findings.
  - Implementation:
    - Include `result.correctness` and `correctnessStatus` in migration JSON.
    - Split migration gate reasons:
      - unsupported operation
      - correctness error
      - part rewrite review
      - metadata-only clean
    - Keep default conservative behavior if desired, but expose the reason.
  - Acceptance:
    - CI JSON can distinguish “rewrite review” from “current data breaks.”
    - Human output says exactly why exit code 1 occurred.

- [ ] Align `dry_run_migration` MCP structured output with the shared verdict
      contract.
  - Primary file:
    - `packages/cli/src/tools/dry-run-migration.ts`
  - Implementation:
    - Preserve existing `classification`, `rewrite`, and `correctness`.
    - Add top-level `verdict`, `method`, and `coverage`.
    - Use `metadata-estimate` for rewrite footprint.
    - Use `read-only-live-data` for correctness findings.
  - Acceptance:
    - Structured output keeps provenance for each finding.
    - No single “migration correct” verdict is emitted from a rewrite estimate.

- [ ] Add an honesty footer to all human reports.
  - Primary files:
    - `packages/cli/src/tools/verify-equivalent.ts`
    - `packages/cli/src/tools/verify-dedup.ts`
    - `packages/cli/src/tools/dry-run-migration.ts`
    - `packages/cli/src/tools/diagnose-query.ts`
  - Content should include:
    - whether the original artifact was executed;
    - whether the method was exact, metadata-only, EXPLAIN-only, or advisory;
    - whether data left the machine;
    - whether result rows are sampled/capped.
  - Acceptance:
    - A user can tell at a glance what was proven and what was not.

## P1: Validation Against Real ClickHouse

- [ ] Run and document one live-cluster validation.
  - Existing automation:
    - `.github/workflows/integration.yml`
    - `packages/cli/tests/integration/guardrails.integration.test.ts`
  - Required manual/live matrix:
    - local ClickHouse Docker;
    - one ClickHouse Cloud or real self-hosted deployment;
    - one read-only account;
    - one write-capable account with gozzle `readonly=2` enforced.
  - Checks to run:
    - `connect`
    - `inspect_table`
    - `verify_dedup`
    - `diagnose_query`
    - `verify_equivalent`
    - `dry_run_migration`
    - `gozzle verify`
  - Acceptance:
    - A short `WALKTHROUGH.md` or docs page shows commands, sanitized output,
      and what was proven.
    - At least one real or realistic bug is demonstrated.

- [ ] Add integration coverage for migration correctness probes.
  - Primary tests:
    - `packages/cli/tests/integration/*.test.ts`
  - Implementation:
    - Create a table with values that fail a cast.
    - Run `dryRunMigration` for `MODIFY COLUMN`.
    - Run `ALTER ... UPDATE` with a broken expression.
    - Assert production ALTER is not run and correctness returns an error.
  - Acceptance:
    - Integration tests prove read-only migration correctness behavior against
      a real ClickHouse server, not only fakes.

- [ ] Add a smoke test for packaged MCP server startup.
  - Existing script:
    - `packages/cli/package.json` has `smoke:mcp`.
  - Implementation:
    - Ensure release workflow runs `npm run smoke:mcp -w @gozzle/cli`.
    - Confirm the built `gozzle-mcp` stdio server starts and exposes tool
      metadata.
  - Acceptance:
    - Release cannot publish a broken MCP entrypoint.

## P1: Documentation And Launch Narrative

- [ ] Rewrite root README for users, not monorepo contributors.
  - Primary file:
    - `README.md`
  - Current issue:
    - Root README is mostly repo layout.
  - Implementation:
    - Lead with product category and install command.
    - Add “what it catches” examples.
    - Add quick CLI and MCP setup.
    - Move monorepo details under “Development.”
  - Acceptance:
    - A new user understands in 30 seconds why gozzle exists and how to try it.

- [ ] Make `packages/cli/README.md` match the web docs.
  - Primary file:
    - `packages/cli/README.md`
  - Implementation:
    - Add the current tool list.
    - Document `verify_equivalent`, `gozzle hook`, and migration correctness.
    - Keep local slice data retention warning prominent.
  - Acceptance:
    - npm package page is complete without requiring the website.

- [ ] Update changelog before release.
  - Primary file:
    - `CHANGELOG.md`
  - Add under `[Unreleased]`:
    - migration read-only correctness gate;
    - `verify_equivalent`;
    - PostToolUse hook;
    - web/docs changes;
    - any changed structured output fields.
  - Acceptance:
    - Changelog describes user-visible behavior since `0.1.5`.

- [ ] Add a “claims and limits” docs page.
  - Suggested path:
    - `apps/web/content/docs/claims-and-limits.mdx`
  - Include:
    - exact-source vs read-only-live-data vs EXPLAIN/advisory;
    - what “correct” means;
    - what `dry_run_migration` cannot prove;
    - why `readonly=2` is still required even for read-only tools.
  - Acceptance:
    - Public docs make overclaiming difficult for users and agents.

## P2: Code Quality And Maintainability

- [ ] Reduce duplicated unsafe SQL function detection.
  - Current locations:
    - `packages/cli/src/clickhouse/migration-parser.ts`
    - `packages/cli/src/clickhouse/migration.ts`
    - `packages/cli/src/clickhouse/query-validator.ts`
  - Implementation:
    - Move external-access function detection to a shared module.
    - Reuse it for queries, predicates, and migration expressions.
  - Acceptance:
    - Adding/removing a blocked function is a one-file change.
    - Tests cover string-literal masking and identifier edge cases.

- [ ] Harden SQL parser boundaries with explicit tests.
  - Primary tests:
    - `packages/cli/tests/migration-parser.test.ts`
    - `packages/cli/tests/query-validator.test.ts`
  - Cases:
    - nested parentheses;
    - quoted identifiers;
    - escaped quotes;
    - `SETTINGS` as a column vs trailing clause;
    - comma in function arguments;
    - DEFAULT/MATERIALIZED expression with trailing clauses.
  - Acceptance:
    - Every supported parser concession has a regression test.

- [ ] Add a “parser says unsupported” path for risky ambiguity.
  - Primary file:
    - `packages/cli/src/clickhouse/migration-parser.ts`
  - Implementation:
    - Where parsing is ambiguous, return `unsupported` with an explicit reason
      rather than attaching partial metadata.
  - Acceptance:
    - No correctness probe runs against a partially parsed migration expression.

- [ ] Add release workflow quality gates.
  - Primary files:
    - `.github/workflows/build.yml`
    - `.github/workflows/release.yml`
    - `.github/workflows/publish-canary.yml`
  - Implementation:
    - Run `npm run lint`.
    - Run `npm run format:check`.
    - Run `npm run smoke:mcp -w @gozzle/cli`.
  - Acceptance:
    - Main/canary/release all enforce the same quality gate as the PR
      checklist.

## P2: Local Slice And Data Handling

- [ ] Decide whether persistent slices belong in the launch hero.
  - Current files:
    - `packages/cli/src/local-engine/slice.ts`
    - `packages/cli/src/tools/create-local-slice.ts`
    - `apps/web/content/docs/local-slices.mdx`
  - Current state:
    - Slices are explicit, persistent, and well warned.
    - There is no ephemeral verify-replica lifecycle yet.
  - Implementation options:
    - Keep slices as an advanced tool, not the launch hero.
    - Or build ephemeral verify replicas before making “local shadow
      execution” a central claim.
  - Acceptance:
    - Public copy does not imply automatic local shadow migration execution.

- [ ] Add ephemeral replica cleanup design before implementing migration shadow
      execution.
  - Future files likely affected:
    - `packages/cli/src/local-engine/`
    - `packages/cli/src/config/local-slice.ts`
  - Required behavior:
    - `try/finally` cleanup;
    - orphan sweep on startup;
    - disk free-space check;
    - SIGINT/SIGTERM cleanup;
    - explicit `gozzle gc`.
  - Acceptance:
    - A failed verification cannot silently leave large copied data behind.

## P2: Agent Integration

- [ ] Make deterministic verification available beyond Claude Code hooks.
  - Current files:
    - `packages/cli/src/init/hook-recipe.ts`
    - `packages/cli/src/commands/hook.ts`
    - `apps/web/content/docs/verify.mdx`
  - Implementation:
    - Document what is Claude-specific.
    - Add Codex/Cursor-friendly deterministic flows where possible.
    - Keep `gozzle verify --changed` as the cross-agent fallback.
  - Acceptance:
    - The public story does not rely on agents remembering to call MCP tools.

- [ ] Add agent prompt snippets that distinguish proof from advice.
  - Primary file:
    - `packages/cli/src/init/agent-skill.ts`
  - Implementation:
    - Instruct agents to report:
      - exact proof;
      - advisory findings;
      - unsupported checks;
      - migration rewrite review separately.
  - Acceptance:
    - Agent output does not flatten advisory and proven results into one
      “passed” claim.

## Suggested Release Gate

Do not call this production-ready until all P0 and P1 items are complete.

Minimum command gate:

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run smoke:mcp -w @gozzle/cli
npm run test:integration -w @gozzle/cli
```

Manual gate:

- [ ] One real ClickHouse or ClickHouse Cloud validation run.
- [ ] One demo showing a real failing check with proof.
- [ ] Website hero and docs no longer overclaim.
- [ ] `CHANGELOG.md` and npm README are current.

## Current Rating Baseline

- OSS alpha/canary: **8/10**
- Production release: **6.5/10**

Target before production release: **8/10+**, with remaining gaps limited to
post-launch product depth rather than correctness, positioning, or release
hygiene.
