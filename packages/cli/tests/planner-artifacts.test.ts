import assert from "node:assert/strict";
import test from "node:test";

import { classifyArtifact } from "../src/planner/artifacts.js";

test("classifyArtifact recognizes a query", () => {
  const artifact = classifyArtifact({
    source: "content",
    content: "-- header\nSELECT * FROM events;"
  });
  assert.equal(artifact.type, "query");
  assert.equal(artifact.statement, "SELECT * FROM events");
});

test("classifyArtifact recognizes a migration", () => {
  const artifact = classifyArtifact({
    source: "content",
    content: "ALTER TABLE events ADD COLUMN source String;"
  });
  assert.equal(artifact.type, "migration");
});

test("classifyArtifact recognizes a query pair", () => {
  const artifact = classifyArtifact({
    source: "query_pair",
    left: "SELECT 1;",
    right: "SELECT 1"
  });
  assert.equal(artifact.type, "query_pair");
  assert.equal(artifact.left, "SELECT 1");
  assert.equal(artifact.right, "SELECT 1");
});

test("classifyArtifact reports unsupported content", () => {
  const artifact = classifyArtifact({
    source: "content",
    content: "INSERT INTO events VALUES (1)"
  });
  assert.equal(artifact.type, "unknown");
  assert.match(artifact.reason ?? "", /not a supported/i);
});
