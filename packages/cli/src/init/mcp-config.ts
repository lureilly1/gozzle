/**
 * Builds host-specific MCP configuration snippets for `gozzle init`.
 *
 * The goal is a tight first-session proof path: a beta user should be able to
 * copy one block into their AI host and run the first check in minutes. We fill
 * non-secret connection fields from the environment when present, but never echo
 * a password into a snippet that might be pasted into a shared file or shown on
 * a screen share.
 */

export type HostId = "claude" | "cursor" | "codex";

export const HOST_IDS: readonly HostId[] = ["claude", "cursor", "codex"];

export interface ConnectionPlaceholders {
  url: string;
  user: string;
  database: string;
}

export interface SnippetEnv {
  GOZZLE_CLICKHOUSE_URL?: string;
  CLICKHOUSE_URL?: string;
  GOZZLE_CLICKHOUSE_USER?: string;
  GOZZLE_CLICKHOUSE_USERNAME?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_USERNAME?: string;
  GOZZLE_CLICKHOUSE_DATABASE?: string;
  CLICKHOUSE_DATABASE?: string;
}

export interface HostSnippet {
  id: HostId;
  title: string;
  /** Where the host expects this configuration to live. */
  configPath: string;
  /** The block the user pastes into that file. */
  snippet: string;
  /** Optional one-liner that achieves the same result from a shell. */
  cliCommand?: string;
}

/**
 * The password is never resolved from the environment or accepted from a
 * caller: snippets always carry a placeholder so a real secret can never be
 * printed, pasted into a shared file, or shown on a screen share.
 */
export const PASSWORD_PLACEHOLDER = "replace-me";

/**
 * Resolve the connection values shown in snippets. URL, user, and database are
 * pulled from the environment when set so a configured user sees their own
 * values. There is deliberately no password field.
 */
export function resolvePlaceholders(
  env: SnippetEnv = process.env
): ConnectionPlaceholders {
  return {
    url:
      firstNonEmpty(env.GOZZLE_CLICKHOUSE_URL, env.CLICKHOUSE_URL) ??
      "https://your-cluster.clickhouse.cloud:8443",
    user:
      firstNonEmpty(
        env.GOZZLE_CLICKHOUSE_USER,
        env.GOZZLE_CLICKHOUSE_USERNAME,
        env.CLICKHOUSE_USER,
        env.CLICKHOUSE_USERNAME
      ) ?? "gozzle_readonly",
    database:
      firstNonEmpty(env.GOZZLE_CLICKHOUSE_DATABASE, env.CLICKHOUSE_DATABASE) ??
      "default"
  };
}

function connectionEnv(conn: ConnectionPlaceholders): Record<string, string> {
  return {
    GOZZLE_CLICKHOUSE_URL: conn.url,
    GOZZLE_CLICKHOUSE_USER: conn.user,
    GOZZLE_CLICKHOUSE_PASSWORD: PASSWORD_PLACEHOLDER,
    GOZZLE_CLICKHOUSE_DATABASE: conn.database
  };
}

/**
 * How the host launches the server. Global installs invoke the `gozzle-mcp` bin
 * directly; a project-local install (devDependency) is launched via `npx` so the
 * host resolves the version committed to the repo.
 */
function serverInvocation(local: boolean): {
  command: string;
  args?: string[];
} {
  return local
    ? { command: "npx", args: ["gozzle-mcp"] }
    : { command: "gozzle-mcp" };
}

function jsonMcpServers(conn: ConnectionPlaceholders, local: boolean): string {
  const { command, args } = serverInvocation(local);
  return JSON.stringify(
    {
      mcpServers: {
        gozzle: {
          command,
          ...(args ? { args } : {}),
          env: connectionEnv(conn)
        }
      }
    },
    null,
    2
  );
}

function buildClaude(
  conn: ConnectionPlaceholders,
  local: boolean
): HostSnippet {
  const env = connectionEnv(conn);
  const envFlags = Object.entries(env)
    .map(([key, value]) => `--env ${key}="${value}"`)
    .join(" ");
  const launch = local ? "npx gozzle-mcp" : "gozzle-mcp";

  return {
    id: "claude",
    title: "Claude Code",
    configPath: ".mcp.json (project) or ~/.claude.json (user)",
    snippet: jsonMcpServers(conn, local),
    cliCommand: `claude mcp add gozzle ${envFlags} -- ${launch}`
  };
}

function buildCursor(
  conn: ConnectionPlaceholders,
  local: boolean
): HostSnippet {
  return {
    id: "cursor",
    title: "Cursor",
    configPath: "~/.cursor/mcp.json (global) or .cursor/mcp.json (project)",
    snippet: jsonMcpServers(conn, local)
  };
}

function buildCodex(conn: ConnectionPlaceholders, local: boolean): HostSnippet {
  const env = connectionEnv(conn);
  const envInline = Object.entries(env)
    .map(([key, value]) => `${key} = "${value}"`)
    .join(", ");
  const { command, args } = serverInvocation(local);

  const snippet = [
    "[mcp_servers.gozzle]",
    `command = "${command}"`,
    ...(args ? [`args = [${args.map((a) => `"${a}"`).join(", ")}]`] : []),
    `env = { ${envInline} }`
  ].join("\n");

  return {
    id: "codex",
    title: "Codex",
    configPath: "~/.codex/config.toml",
    snippet
  };
}

const BUILDERS: Record<
  HostId,
  (conn: ConnectionPlaceholders, local: boolean) => HostSnippet
> = {
  claude: buildClaude,
  cursor: buildCursor,
  codex: buildCodex
};

export function buildSnippet(
  host: HostId,
  conn: ConnectionPlaceholders = resolvePlaceholders(),
  local = false
): HostSnippet {
  return BUILDERS[host](conn, local);
}

export function isHostId(value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value);
}

/**
 * Render the full `gozzle init` output. With no host, every host is shown; with
 * a host, only that one. Read-only guidance is always included because it is the
 * core safety promise users are trusting.
 */
export function renderInit(
  host?: HostId,
  conn: ConnectionPlaceholders = resolvePlaceholders(),
  local = false
): string {
  const hosts = host ? [host] : HOST_IDS;
  const lines: string[] = [
    `Configure gozzle as an MCP server in your AI host (${
      local
        ? "project-local install — launched via npx"
        : "global install — requires `npm i -g @gozzle/cli`"
    }).`,
    ""
  ];

  for (const id of hosts) {
    const built = buildSnippet(id, conn, local);
    lines.push(`# ${built.title}`);
    lines.push(`Config file: ${built.configPath}`);
    lines.push("");
    lines.push(built.snippet);
    if (built.cliCommand) {
      lines.push("");
      lines.push("Or from a shell:");
      lines.push(built.cliCommand);
    }
    lines.push("");
  }

  lines.push("Before you connect:");
  lines.push(
    "- Use a read-only ClickHouse user. gozzle does not need write access and forces readonly=2 on every query."
  );
  lines.push(
    "- Replace the password placeholder. gozzle reads it from the host config, not this output."
  );
  lines.push(
    "- No table data leaves your machine unless you explicitly create a local slice."
  );

  return lines.join("\n");
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}
