// The PostToolUse hook recipe: deterministic, free, local. Unlike the skill
// (which the agent may under-trigger), a hook runs after every matching tool
// call regardless of the model's discretion, so ClickHouse SQL is verified the
// moment it's written.
export function renderHookRecipe(local = false): string {
  const command = local ? "npx gozzle hook run" : "gozzle hook run";
  const config = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [{ type: "command", command }]
        }
      ]
    }
  };

  return [
    "Add this PostToolUse hook so your agent verifies ClickHouse SQL automatically.",
    "",
    "Where: .claude/settings.json (project) or ~/.claude/settings.json (user)",
    "",
    JSON.stringify(config, null, 2),
    "",
    "After the agent edits a .sql file, gozzle verifies it against your configured",
    "ClickHouse (set GOZZLE_CLICKHOUSE_URL etc.). On findings it blocks and shows the",
    "verdict to the agent; non-SQL edits and setup issues are ignored silently.",
    "Claude Code supports PostToolUse hooks; other agents use their own equivalent."
  ].join("\n");
}
