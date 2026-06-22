# gozzle

A safety harness for your ClickHouse, inside your own AI.

This repository is an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) monorepo.

## Layout

| Path | Package | Description |
| --- | --- | --- |
| `packages/cli` | [`@gozzle/cli`](packages/cli/README.md) | The CLI and MCP stdio server (published to npm). |
| `apps/web` | `@gozzle/web` (private) | Documentation site — Next.js + [Fumadocs](https://fumadocs.dev). Placeholder for now. |

## Getting started

```bash
npm install          # installs all workspaces
npm run build        # builds every workspace
npm test             # runs the @gozzle/cli test suite
```

### Working on a single package

```bash
npm run build:cli    # build @gozzle/cli
npm run build:web    # build the docs site
npm run dev:web      # run the docs site locally (http://localhost:3000)
```

## Publishing

`@gozzle/cli` is published as a canary on every push to `main` via
`.github/workflows/publish-canary.yml`. See
[`packages/cli/README.md`](packages/cli/README.md) for details.
