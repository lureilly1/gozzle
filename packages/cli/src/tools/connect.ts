import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ClickHouseHttpMetadataClient } from "../clickhouse/client.js";
import { inspectClickHouseConnection } from "../clickhouse/introspection.js";
import { readClickHouseConfig } from "../config/clickhouse.js";

export function createConnectTool(server: McpServer): void {
  server.registerTool(
    "connect",
    {
      title: "Connect to ClickHouse",
      description:
        "Validate the configured ClickHouse connection and report read-only guardrails.",
      inputSchema: {}
    },
    async () => {
      let client: ClickHouseHttpMetadataClient | undefined;

      try {
        const config = readClickHouseConfig();
        client = new ClickHouseHttpMetadataClient(config);
        const info = await inspectClickHouseConnection(client, config);

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
              text: `Gozzle could not connect to ClickHouse.\n\n${formatErrorMessage(
                error
              )}`
            }
          ]
        };
      } finally {
        await client?.close();
      }
    }
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
    `Readonly setting: ${info.readonlySetting ?? "unknown"}`
  ];

  if (info.writePrivileges.length > 0) {
    lines.push(`Write-capable grants: ${info.writePrivileges.join(", ")}`);
  }

  if (info.warnings.length > 0) {
    lines.push("", "Warnings:");
    lines.push(...info.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

