import type { ClickHouseConnectionConfig } from "../config/clickhouse.js";
import { errorMessage } from "../shared/errors.js";
import {
  DEFAULT_GUARDRAILS,
  type GuardrailConfig
} from "../config/guardrails.js";
import type { ClickHouseMetadataClient } from "./client.js";

export interface ClickHouseConnectionInfo {
  connected: true;
  version: string;
  database: string;
  currentUser: string;
  hostName: string;
  deployment: "cloud" | "self_hosted_or_unknown";
  /** Whether gozzle enforces a read-only session on every query. */
  readonlyEnforced: boolean;
  /** Effective `readonly` value observed on the connection (proof). */
  effectiveReadonly?: string;
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
  config: ClickHouseConnectionConfig,
  guardrails: GuardrailConfig = DEFAULT_GUARDRAILS
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
  const effectiveReadonly = await readReadonlySetting(client, warnings);
  const writePrivileges = await readWritePrivileges(client, warnings);

  if (!guardrails.enforceReadonly) {
    warnings.push(
      "gozzle read-only enforcement is disabled (GOZZLE_ENFORCE_READONLY=false). Queries are not forced read-only."
    );
  }

  if (writePrivileges.length > 0) {
    warnings.push(
      `Connected user has write-capable grants: ${writePrivileges.join(
        ", "
      )}. gozzle never writes, but a least-privilege read-only user is recommended.`
    );
  }

  return {
    connected: true,
    version: String(serverInfo.version),
    database: serverInfo.database,
    currentUser: serverInfo.current_user,
    hostName: serverInfo.host_name,
    deployment: detectDeployment(config.url),
    readonlyEnforced: guardrails.enforceReadonly,
    effectiveReadonly,
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
    warnings.push(`Could not inspect readonly setting: ${errorMessage(error)}`);
    return undefined;
  }
}

async function readWritePrivileges(
  client: ClickHouseMetadataClient,
  warnings: string[]
): Promise<string[]> {
  try {
    // Privileges may be granted directly to the user or inherited via roles
    // (the default on ClickHouse Cloud, where the admin user's grants live on
    // `default_role`). Include both so write-capable accounts are detected.
    const rows = await client.queryJson<GrantRow>(`
      SELECT DISTINCT access_type
      FROM system.grants
      WHERE user_name = currentUser()
        OR role_name IN (SELECT role_name FROM system.enabled_roles)
      ORDER BY access_type
    `);

    return rows
      .map((row) => row.access_type)
      .filter((accessType) => WRITE_PRIVILEGES.has(accessType));
  } catch (error) {
    warnings.push(`Could not inspect grants: ${errorMessage(error)}`);
    return [];
  }
}
