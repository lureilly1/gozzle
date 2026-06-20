import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_SLICE_BYTES,
  DEFAULT_MAX_SLICE_ROWS,
  DEFAULT_MAX_TOTAL_SLICE_BYTES,
  readLocalSliceConfig
} from "../src/config/local-slice.js";

test("local slice config uses bounded defaults", () => {
  const config = readLocalSliceConfig({});
  assert.equal(config.maxRows, DEFAULT_MAX_SLICE_ROWS);
  assert.equal(config.maxBytes, DEFAULT_MAX_SLICE_BYTES);
  assert.equal(config.maxTotalBytes, DEFAULT_MAX_TOTAL_SLICE_BYTES);
  assert.match(config.rootDirectory, /\.gozzle\/slices$/);
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
