import type { ClickHouseConnectionConfig } from "../config/clickhouse.js";
import type { ClickHouseMetadataClient } from "./client.js";

export interface ClickHouseConnectionInfo {
  connected: true;
  version: string;
  database: string;
  currentUser: string;
  hostName: string;
  deployment: "cloud" | "self_hosted_or_unknown";
  readonlySetting?: string;
  writePrivileges: string[];
  warnings: string[];
}

interface ServerInfoRow {
  version: string | number;
  database: string;
  current_user: string;
  host_name: string;
}

interface SettingRow {
  value: string | number;
}

interface GrantRow {
  access_type: string;
}

const WRITE_PRIVILEGES = new Set([
  "INSERT",
  "ALTER",
  "CREATE",
  "DROP",
  "TRUNCATE",
  "OPTIMIZE",
  "SYSTEM",
  "KILL QUERY"
]);

export async function inspectClickHouseConnection(
  client: ClickHouseMetadataClient,
  config: ClickHouseConnectionConfig
): Promise<ClickHouseConnectionInfo> {
  const pingOk = await client.ping();

  if (!pingOk) {
    throw new Error("ClickHouse ping failed.");
  }

  const [serverInfo] = await client.queryJson<ServerInfoRow>(`
    SELECT
      version() AS version,
      currentDatabase() AS database,
      currentUser() AS current_user,
      hostName() AS host_name
  `);

  if (!serverInfo) {
    throw new Error("ClickHouse did not return server metadata.");
  }

  const warnings: string[] = [];
  const readonlySetting = await readReadonlySetting(client, warnings);
  const writePrivileges = await readWritePrivileges(client, warnings);

  if (readonlySetting !== undefined && readonlySetting !== "1") {
    warnings.push(
      "Session readonly setting is not enabled. Use a read-only ClickHouse user for Gozzle."
    );
  }

  if (writePrivileges.length > 0) {
    warnings.push(
      `Connected user appears to have write-capable grants: ${writePrivileges.join(
        ", "
      )}. Gozzle only needs read-only access.`
    );
  }

  return {
    connected: true,
    version: String(serverInfo.version),
    database: serverInfo.database,
    currentUser: serverInfo.current_user,
    hostName: serverInfo.host_name,
    deployment: detectDeployment(config.url),
    readonlySetting,
    writePrivileges,
    warnings
  };
}

export function detectDeployment(
  url: string
): ClickHouseConnectionInfo["deployment"] {
  const hostname = new URL(url).hostname;
  return hostname.endsWith(".clickhouse.cloud")
    ? "cloud"
    : "self_hosted_or_unknown";
}

async function readReadonlySetting(
  client: ClickHouseMetadataClient,
  warnings: string[]
): Promise<string | undefined> {
  try {
    const [row] = await client.queryJson<SettingRow>(`
      SELECT value
      FROM system.settings
      WHERE name = 'readonly'
      LIMIT 1
    `);

    return row ? String(row.value) : undefined;
  } catch (error) {
    warnings.push(
      `Could not inspect readonly setting: ${formatErrorMessage(error)}`
    );
    return undefined;
  }
}

async function readWritePrivileges(
  client: ClickHouseMetadataClient,
  warnings: string[]
): Promise<string[]> {
  try {
    const rows = await client.queryJson<GrantRow>(`
      SELECT DISTINCT access_type
      FROM system.grants
      WHERE user_name = currentUser()
      ORDER BY access_type
    `);

    return rows
      .map((row) => row.access_type)
      .filter((accessType) => WRITE_PRIVILEGES.has(accessType));
  } catch (error) {
    warnings.push(`Could not inspect grants: ${formatErrorMessage(error)}`);
    return [];
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

