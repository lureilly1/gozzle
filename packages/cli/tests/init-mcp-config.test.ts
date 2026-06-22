import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_IDS,
  buildSnippet,
  isHostId,
  renderInit,
  resolvePlaceholders
} from "../src/init/mcp-config.js";

test("resolvePlaceholders fills non-secret fields from env", () => {
  const conn = resolvePlaceholders({
    GOZZLE_CLICKHOUSE_URL: "https://example.clickhouse.cloud:8443",
    CLICKHOUSE_USER: "analyst",
    GOZZLE_CLICKHOUSE_DATABASE: "metrics"
  });

  assert.equal(conn.url, "https://example.clickhouse.cloud:8443");
  assert.equal(conn.user, "analyst");
  assert.equal(conn.database, "metrics");
});

test("resolvePlaceholders prefers GOZZLE_ over CLICKHOUSE_ and falls back to placeholders", () => {
  const conn = resolvePlaceholders({
    GOZZLE_CLICKHOUSE_USER: "gozzle_ro",
    CLICKHOUSE_USER: "ignored"
  });

  assert.equal(conn.user, "gozzle_ro");
  assert.equal(conn.url, "https://your-cluster.clickhouse.cloud:8443");
  assert.equal(conn.database, "default");
});

test("password is structurally a placeholder and cannot be injected via env", () => {
  // The connection type has no password field, so a secret cannot reach a
  // snippet even if present in the environment.
  const conn = resolvePlaceholders({
    GOZZLE_CLICKHOUSE_URL: "https://example:8443"
  } as Record<string, string>);
  const output = renderInit(undefined, conn);

  assert.ok(!output.includes("super-secret"));
  assert.ok(output.includes("replace-me"));
});

test("claude snippet is valid JSON with gozzle-mcp command and a CLI fallback", () => {
  const built = buildSnippet("claude");

  const parsed = JSON.parse(built.snippet);
  assert.equal(parsed.mcpServers.gozzle.command, "gozzle-mcp");
  assert.equal(
    parsed.mcpServers.gozzle.env.GOZZLE_CLICKHOUSE_PASSWORD,
    "replace-me"
  );
  assert.match(built.cliCommand ?? "", /^claude mcp add gozzle .*-- gozzle-mcp$/);
});

test("cursor snippet is valid JSON in the mcpServers shape", () => {
  const built = buildSnippet("cursor");
  const parsed = JSON.parse(built.snippet);
  assert.equal(parsed.mcpServers.gozzle.command, "gozzle-mcp");
  assert.match(built.configPath, /\.cursor\/mcp\.json/);
});

test("codex snippet is TOML using the mcp_servers table", () => {
  const built = buildSnippet("codex");
  assert.match(built.snippet, /\[mcp_servers\.gozzle\]/);
  assert.match(built.snippet, /command = "gozzle-mcp"/);
  assert.match(built.snippet, /GOZZLE_CLICKHOUSE_URL = "/);
  assert.match(built.configPath, /\.codex\/config\.toml/);
});

test("renderInit with no host includes every supported host", () => {
  const output = renderInit();
  for (const id of HOST_IDS) {
    assert.ok(output.includes(buildSnippet(id).title), `missing ${id}`);
  }
});

test("renderInit with a host shows only that host", () => {
  const output = renderInit("codex");
  assert.ok(output.includes("Codex"));
  assert.ok(!output.includes("Cursor"));
  assert.ok(!output.includes("Claude Code"));
});

test("renderInit always carries the read-only safety guidance", () => {
  const output = renderInit("cursor");
  assert.match(output, /read-only/i);
  assert.match(output, /readonly=2/);
  assert.match(output, /No table data leaves your machine/i);
});

test("local mode launches the server via npx (Claude JSON + CLI)", () => {
  const built = buildSnippet("claude", undefined, true);
  const parsed = JSON.parse(built.snippet);
  assert.equal(parsed.mcpServers.gozzle.command, "npx");
  assert.deepEqual(parsed.mcpServers.gozzle.args, ["gozzle-mcp"]);
  assert.match(built.cliCommand ?? "", /-- npx gozzle-mcp$/);
});

test("local mode emits npx command + args in Codex TOML", () => {
  const built = buildSnippet("codex", undefined, true);
  assert.match(built.snippet, /command = "npx"/);
  assert.match(built.snippet, /args = \["gozzle-mcp"\]/);
});

test("global mode (default) still invokes the gozzle-mcp bin directly", () => {
  const parsed = JSON.parse(buildSnippet("cursor").snippet);
  assert.equal(parsed.mcpServers.gozzle.command, "gozzle-mcp");
  assert.equal(parsed.mcpServers.gozzle.args, undefined);
});

test("renderInit notes the install mode", () => {
  assert.match(renderInit(undefined, undefined, true), /project-local install/);
  assert.match(renderInit(), /global install/);
});

test("isHostId recognizes supported hosts and rejects others", () => {
  assert.ok(isHostId("claude"));
  assert.ok(isHostId("cursor"));
  assert.ok(isHostId("codex"));
  assert.ok(!isHostId("vscode"));
});
