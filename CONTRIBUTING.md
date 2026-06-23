# Contributing to gozzle

Thanks for your interest in gozzle. It's a local, read-only ClickHouse safety
harness: an AI agent reasons, gozzle runs bounded checks and returns verdicts
plus proof. That posture — **never write to or copy data out of a cluster
unless the user explicitly creates a local slice** — is the most important thing
to preserve in any change.

## Project layout

This is an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
monorepo.

| Path | Package | What it is |
| --- | --- | --- |
| `packages/cli` | `@gozzle/cli` | The product: the `gozzle` CLI and `gozzle-mcp` stdio server (published to npm). |
| `apps/web` | `@gozzle/web` (private) | The docs/marketing site (Next.js + Fumadocs). |

Inside `packages/cli/src`:

| Directory | Responsibility |
| --- | --- |
| `clickhouse/` | Read-only HTTP client, schema/dedup/migration/EXPLAIN logic, SQL scanning. |
| `commands/` | CLI subcommands (`verify`, `discover`, `equivalent`, `hook`). |
| `config/` | Environment + `gozzle.yaml` parsing, guardrails. |
| `tools/` | MCP tool registrations (one file per tool). |
| `local-engine/` | The optional chDB local slice engine and slice store. |
| `shared/` | Cross-cutting helpers (formatting, errors, fingerprints, audit). |
| `init/` | Generators for MCP config, agent skills, and the hook recipe. |

## Prerequisites

- Node.js **>= 22** (the repo is ESM + TypeScript).
- chDB is an *optional* dependency used only by `create_local_slice`; everything
  else works without it.

## Getting started

```bash
npm install      # install all workspaces
npm run build    # build every workspace
npm test         # run the @gozzle/cli test suite
```

To iterate on the CLI or MCP server directly with `tsx` (no build step):

```bash
npm run dev -w @gozzle/cli           # run the CLI
npm run dev:mcp -w @gozzle/cli       # run the MCP stdio server
```

## Before you open a PR

Run all four and make sure they pass:

```bash
npm run format       # apply Prettier
npm run lint         # ESLint
npm run typecheck -w @gozzle/cli   # tsc --noEmit
npm test             # unit tests (149+)
```

`npm run format:check` is the non-mutating form used in CI.

### Tests

- Unit tests live in `packages/cli/tests/*.test.ts` and run against fake clients
  — no server required. Run a single file with
  `node --import tsx --test packages/cli/tests/<file>.test.ts`.
- Integration tests (`tests/integration/*.test.ts`) need a real ClickHouse
  and/or chDB and are skipped automatically when unavailable. Run them with
  `npm run test:integration -w @gozzle/cli`.

New behavior should come with a unit test. Parsing, classification, and
formatting are all testable with the fake clients already in `tests/`.

## Conventions

- **Read-only by construction.** Every query goes through the HTTP client, which
  sets `readonly=2` and cost guardrails. Don't add code paths that write, run
  DDL, or exfiltrate data. New tools must never execute the user's original
  query — analyze with `EXPLAIN`/metadata instead.
- **Quote and escape.** Use the helpers in `clickhouse/identifier.ts`
  (`quoteIdentifier`, `quoteStringLiteral`) for anything interpolated into SQL.
- **Don't log raw SQL** for sensitive statements; audit entries store a
  `fingerprint()` (SHA-256), not the source.
- Keep tool files thin: register the tool, delegate to `clickhouse/` logic, and
  format the result. Shared formatting belongs in `shared/format.ts`.
- Match the surrounding style; Prettier and ESLint settle the rest.

## Reporting security issues

gozzle is a safety tool, so safety bugs matter. Please report anything that could
cause a write to production, leak data, or bypass the read-only guardrails
privately to the maintainers rather than in a public issue.

## Commit and PR notes

- Keep commits focused; describe the *why*, not just the *what*.
- PRs that change tool behavior should say how the read-only/proof guarantees are
  preserved.
