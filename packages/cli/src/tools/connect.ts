import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorMessage } from "../shared/errors.js";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { inspectClickHouseConnection } from "../clickhouse/introspection.js";
import { readClickHouseConfig } from "../config/clickhouse.js";
import { readGuardrailConfig } from "../config/guardrails.js";
import { runAuditedTool } from "../shared/audit.js";

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
      runAuditedTool("connect", {}, async () => {
        let client: ClickHouseHttpMetadataClient | undefined;

        try {
          const config = readClickHouseConfig();
          const guardrails = readGuardrailConfig();
          client = new ClickHouseHttpMetadataClient(config, guardrails);
          const info = await inspectClickHouseConnection(
            client,
            config,
            guardrails
          );

          return {
            content: [
              {
                type: "text",
                text: formatConnectionInfo(info)
              }
            ]
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `gozzle could not connect to ClickHouse.\n\n${errorMessage(
                  error
                )}`
              }
            ]
          };
        } finally {
          await client?.close();
        }
      })
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
    lines.push(`Account write-capable grants: ${info.writePrivileges.join(", ")}`);
  }

  if (info.warnings.length > 0) {
    lines.push("", "Warnings:");
    lines.push(...info.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}


