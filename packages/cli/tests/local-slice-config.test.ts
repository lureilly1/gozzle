import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EPHEMERAL_CLEANUP_AFTER_MINUTES,
  DEFAULT_MAX_SLICE_BYTES,
  DEFAULT_MAX_SLICE_ROWS,
  DEFAULT_MAX_TOTAL_SLICE_BYTES,
  readEphemeralSliceConfig,
  readLocalSliceConfig
} from "../src/config/local-slice.js";

test("local slice config uses bounded defaults", () => {
  const config = readLocalSliceConfig({});
  assert.equal(config.maxRows, DEFAULT_MAX_SLICE_ROWS);
  assert.equal(config.maxBytes, DEFAULT_MAX_SLICE_BYTES);
  assert.equal(config.maxTotalBytes, DEFAULT_MAX_TOTAL_SLICE_BYTES);
  assert.match(config.rootDirectory, /\.gozzle\/slices$/);
});

test("ephemeral slice config uses temporary defaults", () => {
  const config = readEphemeralSliceConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.persistOnFailure, false);
  assert.equal(
    config.cleanupAfterMinutes,
    DEFAULT_EPHEMERAL_CLEANUP_AFTER_MINUTES
  );
  assert.match(config.rootDirectory, /\.gozzle\/tmp$/);
});

test("ephemeral slice config accepts explicit overrides", () => {
  const config = readEphemeralSliceConfig({
    GOZZLE_EPHEMERAL_SLICE_ENABLED: "false",
    GOZZLE_EPHEMERAL_SLICE_DIR: "/tmp/gozzle-ephemeral",
    GOZZLE_EPHEMERAL_SLICE_PERSIST_ON_FAILURE: "true",
    GOZZLE_EPHEMERAL_SLICE_CLEANUP_AFTER_MINUTES: "5"
  });
  assert.equal(config.enabled, false);
  assert.equal(config.rootDirectory, "/tmp/gozzle-ephemeral");
  assert.equal(config.persistOnFailure, true);
  assert.equal(config.cleanupAfterMinutes, 5);
});

test("local slice config accepts positive overrides and rejects unsafe values", () => {
  const config = readLocalSliceConfig({
    GOZZLE_SLICE_DIR: "/tmp/gozzle-slices",
    GOZZLE_MAX_SLICE_ROWS: "2500",
    GOZZLE_MAX_SLICE_BYTES: "-1",
    GOZZLE_MAX_TOTAL_SLICE_BYTES: "1048576"
  });
  assert.equal(config.rootDirectory, "/tmp/gozzle-slices");
  assert.equal(config.maxRows, 2500);
  assert.equal(config.maxBytes, DEFAULT_MAX_SLICE_BYTES);
  assert.equal(config.maxTotalBytes, 1048576);
});
