import assert from "node:assert/strict";
import test from "node:test";

import {
  readGuardrailConfig,
  toClickHouseSettings
} from "../src/config/guardrails.js";

test("reads guardrail defaults", () => {
  const config = readGuardrailConfig({});

  assert.equal(config.enforceReadonly, true);
  assert.equal(config.maxExecutionTimeSeconds, 30);
  assert.equal(config.maxResultRows, 10000);
  assert.equal(config.maxRowsToRead, 0);
  assert.equal(config.maxBytesToRead, 0);
});

test("reads guardrail overrides from env", () => {
  const config = readGuardrailConfig({
    GOZZLE_ENFORCE_READONLY: "false",
    GOZZLE_MAX_EXECUTION_TIME: "5",
    GOZZLE_MAX_RESULT_ROWS: "100",
    GOZZLE_MAX_BYTES_TO_READ: "1048576"
  });

  assert.equal(config.enforceReadonly, false);
  assert.equal(config.maxExecutionTimeSeconds, 5);
  assert.equal(config.maxResultRows, 100);
  assert.equal(config.maxBytesToRead, 1048576);
});

test("ignores invalid guardrail values", () => {
  const config = readGuardrailConfig({
    GOZZLE_MAX_EXECUTION_TIME: "not-a-number",
    GOZZLE_MAX_RESULT_ROWS: "-7"
  });

  assert.equal(config.maxExecutionTimeSeconds, 30);
  assert.equal(config.maxResultRows, 10000);
});

test("translates guardrails into ClickHouse settings", () => {
  const settings = toClickHouseSettings({
    enforceReadonly: true,
    maxExecutionTimeSeconds: 30,
    maxResultRows: 10000,
    maxRowsToRead: 0,
    maxBytesToRead: 0
  });

  assert.equal(settings.readonly, "2");
  assert.equal(settings.max_execution_time, "30");
  assert.equal(settings.max_result_rows, "10000");
  assert.equal(settings.result_overflow_mode, "throw");
  assert.equal(settings.max_rows_to_read, undefined);
});

test("omits readonly when enforcement is disabled", () => {
  const settings = toClickHouseSettings({
    enforceReadonly: false,
    maxExecutionTimeSeconds: 0,
    maxResultRows: 0,
    maxRowsToRead: 0,
    maxBytesToRead: 0
  });

  assert.equal(settings.readonly, undefined);
  assert.deepEqual(settings, {});
});
