import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordAudit, runAuditedTool } from "../src/shared/audit.js";

test("recordAudit is a no-op when GOZZLE_AUDIT_LOG is unset", async () => {
  await recordAudit(
    {
      timestamp: new Date().toISOString(),
      tool: "health",
      arguments: {},
      outcome: "ok",
      durationMs: 1
    },
    {}
  );
  // No throw, nothing to assert beyond completing.
  assert.ok(true);
});

test("recordAudit appends a JSON line when enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gozzle-audit-"));
  const logPath = join(dir, "audit.log");

  await recordAudit(
    {
      timestamp: "2026-06-20T00:00:00.000Z",
      tool: "inspect_table",
      arguments: { table: "nyc_taxi.trips" },
      outcome: "ok",
      durationMs: 12,
      summary: "Table: nyc_taxi.trips"
    },
    { GOZZLE_AUDIT_LOG: logPath }
  );

  assert.ok(existsSync(logPath));
  const parsed = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.equal(parsed.tool, "inspect_table");
  assert.equal(parsed.arguments.table, "nyc_taxi.trips");
  assert.equal(parsed.outcome, "ok");
});

test("runAuditedTool returns the handler result and derives outcome", async () => {
  const ok = await runAuditedTool("health", {}, async () => ({
    content: [{ type: "text" as const, text: "ok" }]
  }));
  assert.equal(ok.content[0].text, "ok");

  const errored = await runAuditedTool("connect", {}, async () => ({
    isError: true,
    content: [{ type: "text" as const, text: "boom" }]
  }));
  assert.equal(errored.isError, true);
});
