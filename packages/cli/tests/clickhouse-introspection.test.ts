import assert from "node:assert/strict";
import test from "node:test";

import type { ClickHouseMetadataClient } from "../src/clickhouse/client.js";
import {
  detectDeployment,
  inspectClickHouseConnection
} from "../src/clickhouse/introspection.js";

class FakeMetadataClient implements ClickHouseMetadataClient {
  constructor(
    private readonly responses: Record<string, unknown[]>,
    private readonly failingQueries: string[] = []
  ) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async queryJson<T>(query: string): Promise<T[]> {
    const key = Object.keys(this.responses).find((candidate) =>
      query.includes(candidate)
    );

    if (this.failingQueries.some((candidate) => query.includes(candidate))) {
      throw new Error("query failed");
    }

    return (key ? this.responses[key] : []) as T[];
  }

  async close(): Promise<void> {}
}

const serverInfo = {
  version: "25.6.1.1",
  database: "default",
  current_user: "gozzle",
  host_name: "clickhouse-01"
};

test("detects ClickHouse Cloud from hostname", () => {
  assert.equal(
    detectDeployment("https://abc123.us-east-1.aws.clickhouse.cloud:8443"),
    "cloud"
  );
  assert.equal(detectDeployment("http://localhost:8123"), "self_hosted_or_unknown");
});

test("inspects connection metadata and warns on write grants", async () => {
  const client = new FakeMetadataClient({
    "version()": [serverInfo],
    "system.settings": [{ value: "2" }],
    "system.grants": [
      { access_type: "SELECT" },
      { access_type: "INSERT" },
      { access_type: "ALTER" }
    ]
  });

  const info = await inspectClickHouseConnection(client, {
    url: "https://abc123.us-east-1.aws.clickhouse.cloud:8443",
    username: "gozzle",
    password: ""
  });

  assert.equal(info.connected, true);
  assert.equal(info.deployment, "cloud");
  assert.equal(info.version, "25.6.1.1");
  assert.equal(info.readonlyEnforced, true);
  assert.equal(info.effectiveReadonly, "2");
  assert.deepEqual(info.writePrivileges, ["INSERT", "ALTER"]);
  // Default guardrails enforce read-only, so there is no "enforcement disabled"
  // warning, but the over-privileged account is still flagged.
  assert.doesNotMatch(info.warnings.join("\n"), /enforcement is disabled/);
  assert.match(info.warnings.join("\n"), /write-capable grants/);
});

test("warns when read-only enforcement is disabled", async () => {
  const client = new FakeMetadataClient({
    "version()": [serverInfo],
    "system.settings": [{ value: "0" }],
    "system.grants": []
  });

  const info = await inspectClickHouseConnection(
    client,
    {
      url: "http://localhost:8123",
      username: "default",
      password: ""
    },
    {
      enforceReadonly: false,
      maxExecutionTimeSeconds: 0,
      maxResultRows: 0,
      maxRowsToRead: 0,
      maxBytesToRead: 0
    }
  );

  assert.equal(info.readonlyEnforced, false);
  assert.match(info.warnings.join("\n"), /enforcement is disabled/);
});

test("continues when readonly and grant inspection are unavailable", async () => {
  const client = new FakeMetadataClient(
    {
      "version()": [serverInfo]
    },
    ["system.settings", "system.grants"]
  );

  const info = await inspectClickHouseConnection(client, {
    url: "http://localhost:8123",
    username: "default",
    password: ""
  });

  assert.equal(info.connected, true);
  assert.equal(info.effectiveReadonly, undefined);
  assert.deepEqual(info.writePrivileges, []);
  assert.match(info.warnings.join("\n"), /Could not inspect readonly setting/);
  assert.match(info.warnings.join("\n"), /Could not inspect grants/);
});

