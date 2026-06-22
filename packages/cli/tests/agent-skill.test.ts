import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_INSTRUCTION, renderSkill } from "../src/init/agent-skill.js";

test("renderSkill lists every host placement and the instruction by default", () => {
  const output = renderSkill();
  assert.match(output, /Claude Code: CLAUDE\.md/);
  assert.match(output, /Cursor: \.cursor\/rules\/gozzle\.mdc/);
  assert.match(output, /Codex: AGENTS\.md/);
  assert.ok(output.includes(AGENT_INSTRUCTION));
});

test("renderSkill with a host shows only that host's placement", () => {
  const output = renderSkill("cursor");
  assert.match(output, /Cursor: \.cursor\/rules/);
  assert.doesNotMatch(output, /Claude Code:/);
  assert.doesNotMatch(output, /Codex:/);
  assert.ok(output.includes(AGENT_INSTRUCTION));
});

test("the instruction tells the agent to treat gozzle as ground truth and that it is read-only", () => {
  assert.match(AGENT_INSTRUCTION, /verify it with gozzle before giving a final answer/i);
  assert.match(AGENT_INSTRUCTION, /ground truth/i);
  assert.match(AGENT_INSTRUCTION, /read-only/i);
  assert.match(AGENT_INSTRUCTION, /read-path violation/i);
});
