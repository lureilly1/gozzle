import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage } from "../shared/errors.js";

import { inspectClickHouseConnection } from "../clickhouse/introspection.js";
import { readGuardrailConfig } from "../config/guardrails.js";
import { runAuditedTool } from "../shared/audit.js";
import { withClickHouseTool } from "./with-clickhouse.js";

export function createConnectTool(server: McpServer): void {
  server.registerTool(
    "connect",
    {
      title: "Connect to ClickHouse",
      description:
        "Validate the configured ClickHouse connection and report read-only guardrails.",
      inputSchema: {}
    },
    async () =>
      runAuditedTool("connect", {}, () =>
        withClickHouseTool(
          async (client, config) => {
            const guardrails = readGuardrailConfig();
            const info = await inspectClickHouseConnection(
              client,
              config,
              guardrails
            );
            return {
              content: [{ type: "text", text: formatConnectionInfo(info) }]
            };
          },
          (error) =>
            `gozzle could not connect to ClickHouse.\n\n${errorMessage(error)}`
        )
      )
  );
}

type ConnectionInfo = Awaited<ReturnType<typeof inspectClickHouseConnection>>;

function formatConnectionInfo(info: ConnectionInfo): string {
  const lines = [
    "Connected read-only check complete.",
    "No data leaves this machine.",
    "",
    `Version: ${info.version}`,
    `Database: ${info.database}`,
    `User: ${info.currentUser}`,
    `Host: ${info.hostName}`,
    `Deployment: ${info.deployment}`,
    `Read-only enforced by gozzle: ${info.readonlyEnforced ? "yes (readonly=2)" : "no"}`,
    `Effective readonly setting: ${info.effectiveReadonly ?? "unknown"}`
  ];

  if (info.writePrivileges.length > 0) {
    lines.push(
      `Account write-capable grants: ${info.writePrivileges.join(", ")}`
    );
  }

  if (info.warnings.length > 0) {
    lines.push("", "Warnings:");
    lines.push(...info.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}
