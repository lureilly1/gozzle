import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readPackageMetadata } from "../src/shared/package-metadata.js";

test("reads package metadata", () => {
  const packageJson = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8"
    )
  ) as { version: string };

  assert.equal(readPackageMetadata().version, packageJson.version);
});
