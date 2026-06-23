import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractSqlPaths, runHookRun } from "../src/commands/hook.js";
import { renderHookRecipe } from "../src/init/hook-recipe.js";

async function withSqlFile(
  run: (path: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gozzle-hook-"));
  try {
    const path = join(dir, "q.sql");
    await writeFile(path, "SELECT 1", "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("extractSqlPaths pulls an existing .sql file from a PostToolUse payload", async () => {
  await withSqlFile(async (path) => {
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: path }
    });
    assert.deepEqual(extractSqlPaths(payload), [path]);
  });
});

test("extractSqlPaths ignores non-SQL, missing files, and bad JSON", async () => {
  assert.deepEqual(
    extractSqlPaths(JSON.stringify({ tool_input: { file_path: "/tmp/app.ts" } })),
    []
  );
  assert.deepEqual(
    extractSqlPaths(JSON.stringify({ tool_input: { file_path: "/no/such/x.sql" } })),
    []
  );
  assert.deepEqual(extractSqlPaths("not json"), []);
  assert.deepEqual(extractSqlPaths(JSON.stringify({})), []);
});

test("runHookRun is a silent no-op when no .sql file was edited", async () => {
  const code = await runHookRun({
    input: JSON.stringify({ tool_input: { file_path: "/tmp/app.ts" } }),
    env: {} as NodeJS.ProcessEnv
  });
  assert.equal(code, 0);
});

test("runHookRun never disrupts the agent when gozzle can't connect", async () => {
  await withSqlFile(async (path) => {
    // .sql file exists but no ClickHouse configured → must still exit 0.
    const code = await runHookRun({
      input: JSON.stringify({ tool_input: { file_path: path } }),
      env: {} as NodeJS.ProcessEnv
    });
    assert.equal(code, 0);
  });
});

test("renderHookRecipe emits a PostToolUse hook calling the runtime", () => {
  const recipe = renderHookRecipe();
  assert.match(recipe, /PostToolUse/);
  assert.match(recipe, /"matcher": "Edit\|Write\|MultiEdit"/);
  assert.match(recipe, /"command": "gozzle hook run"/);
  assert.match(recipe, /settings\.json/);
});

test("renderHookRecipe --local uses npx", () => {
  assert.match(renderHookRecipe(true), /"command": "npx gozzle hook run"/);
});
