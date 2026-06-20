import { appendFile } from "node:fs/promises";

export interface AuditEntry {
  timestamp: string;
  tool: string;
  arguments: Record<string, unknown>;
  outcome: "ok" | "error";
  durationMs: number;
  summary?: string;
}

export interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Append one JSON line per tool call to the file named by GOZZLE_AUDIT_LOG.
 * Off by default; logging never throws so it can't break a tool.
 */
export async function recordAudit(
  entry: AuditEntry,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const path = env.GOZZLE_AUDIT_LOG;

  if (!path || path.trim() === "") {
    return;
  }

  try {
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Auditing is best-effort: a logging failure must not fail the tool call.
  }
}

/**
 * Run an MCP tool handler, timing it and recording an audit entry derived from
 * the result (outcome from `isError`, summary from the first line of output).
 */
export async function runAuditedTool<T extends ToolResult>(
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  let result: T | undefined;

  try {
    result = await run();
    return result;
  } finally {
    await recordAudit({
      timestamp: new Date().toISOString(),
      tool,
      arguments: args,
      outcome: result && !result.isError ? "ok" : "error",
      durationMs: Date.now() - start,
      summary: result ? summarize(result) : undefined
    });
  }
}

function summarize(result: ToolResult): string | undefined {
  const firstText = result.content.find(
    (part) => part.type === "text" && typeof part.text === "string"
  )?.text;

  if (!firstText) {
    return undefined;
  }

  const firstLine = firstText.split("\n", 1)[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}
