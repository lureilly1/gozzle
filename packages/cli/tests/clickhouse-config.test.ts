import assert from "node:assert/strict";
import test from "node:test";

import { readClickHouseConfig } from "../src/config/clickhouse.js";

test("reads gozzle-prefixed ClickHouse config first", () => {
  const config = readClickHouseConfig({
    CLICKHOUSE_URL: "http://localhost:8123",
    CLICKHOUSE_USER: "default",
    CLICKHOUSE_PASSWORD: "default-password",
    GOZZLE_CLICKHOUSE_URL: "https://example.clickhouse.cloud:8443",
    GOZZLE_CLICKHOUSE_USER: "gozzle",
    GOZZLE_CLICKHOUSE_PASSWORD: "secret",
    GOZZLE_CLICKHOUSE_DATABASE: "analytics"
  });

  assert.deepEqual(config, {
    url: "https://example.clickhouse.cloud:8443",
    username: "gozzle",
    password: "secret",
    database: "analytics"
  });
});

test("defaults username and password for ClickHouse config", () => {
  const config = readClickHouseConfig({
    CLICKHOUSE_URL: "http://localhost:8123"
  });

  assert.equal(config.username, "default");
  assert.equal(config.password, "");
});

test("requires a ClickHouse URL", () => {
  assert.throws(
    () => readClickHouseConfig({}),
    /Missing ClickHouse URL/
  );
});

test("requires an http or https ClickHouse URL", () => {
  assert.throws(
    () =>
      readClickHouseConfig({
        CLICKHOUSE_URL: "tcp://localhost:9000"
      }),
    /must use http or https/
  );
});

