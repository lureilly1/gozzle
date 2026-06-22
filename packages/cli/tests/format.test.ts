import assert from "node:assert/strict";
import test from "node:test";

import { formatBytes, formatCount } from "../src/shared/format.js";

test("formatBytes uses binary units with sensible precision", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.00 KiB");
  assert.equal(formatBytes(1048576), "1.00 MiB");
  assert.equal(formatBytes(620000000000), "577.4 GiB");
  assert.equal(formatBytes(1900000000000), "1.73 TiB");
});

test("formatCount adds thousands separators", () => {
  assert.equal(formatCount(7), "7");
  assert.equal(formatCount(500), "500");
  assert.equal(formatCount(184203991), "184,203,991");
});
