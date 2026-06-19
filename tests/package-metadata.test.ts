import assert from "node:assert/strict";
import test from "node:test";

import { readPackageMetadata } from "../src/shared/package-metadata.js";

test("reads package metadata", () => {
  assert.equal(readPackageMetadata().version, "0.0.1-canary.0");
});
