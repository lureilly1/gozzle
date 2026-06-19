# Gozzle

A safety harness for your ClickHouse, inside your own AI.

Gozzle is a local developer toolkit for ClickHouse. The AI reasons; Gozzle runs checks and produces proof.

## Install

For early canary builds:

```bash
npm install -g @gozzle/cli@canary
```

Then print the MCP config snippet:

```bash
gozzle init
```

Add the printed config to Claude, Cursor, Codex, or another MCP host.

## Development

```bash
npm install
npm run build
npm test
```

## ClickHouse Connection

Gozzle reads ClickHouse connection details from environment variables:

```bash
GOZZLE_CLICKHOUSE_URL=http://localhost:8123
GOZZLE_CLICKHOUSE_USER=default
GOZZLE_CLICKHOUSE_PASSWORD=
GOZZLE_CLICKHOUSE_DATABASE=default
```

The `GOZZLE_` variables take precedence over the equivalent `CLICKHOUSE_` variables.
Use a read-only ClickHouse user; Gozzle does not need write access.

## Entry Points

- `gozzle`: CLI entrypoint.
- `gozzle-mcp`: MCP stdio server entrypoint.

## Canary Publishing

```bash
npm login
npm run build
npm test
npm publish --tag canary --access public
```

For later canaries:

```bash
npm version prerelease --preid canary
npm publish --tag canary --access public
```
