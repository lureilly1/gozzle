import { randomUUID } from "node:crypto";

import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import { dryRunMigration } from "../clickhouse/migration.js";
import { diagnoseQuery } from "../clickhouse/query-diagnosis.js";
import { verifyEquivalent } from "../clickhouse/equivalent.js";
import { fingerprint } from "../shared/fingerprint.js";
import type { Finding, Limit, VerificationRun } from "../shared/verdict.js";
import type { GozzleProjectConfig } from "../config/project.js";
import {
  checkReadPaths,
  type ReadPathOutcome
} from "../commands/verify-read-path.js";
import {
  classifyArtifact,
  type ArtifactInput,
  type ClassifiedArtifact
} from "./artifacts.js";
import { detectCapabilities, type CapabilityOptions } from "./capabilities.js";
import { CHECK_REGISTRY } from "./checks.js";
import { diagnosisToRun } from "./adapters/diagnosis.js";
import { equivalentToRun } from "./adapters/equivalent.js";
import { migrationToRun } from "./adapters/migration.js";

export interface PlanOptions extends CapabilityOptions {
  defaultDatabase: string;
  source: VerificationRun["artifact"]["source"];
  strict?: boolean;
  planOnly?: boolean;
  allowLocalSlice?: boolean;
  path?: string;
  env?: NodeJS.ProcessEnv;
  projectConfig?: GozzleProjectConfig;
}

export async function verifyArtifact(
  client: ClickHouseMetadataClient,
  input: ArtifactInput,
  options: PlanOptions
): Promise<VerificationRun> {
  const artifact = classifyArtifact(input);

  if (artifact.type === "unknown") {
    return unknownArtifactRun(artifact, options);
  }

  if (options.planOnly) {
    return planOnlyRun(artifact, options);
  }

  if (artifact.type === "migration" && artifact.statement) {
    const result = await dryRunMigration(client, {
      statement: artifact.statement,
      defaultDatabase: options.defaultDatabase
    });
    return migrationToRun(
      result,
      options.source,
      options.path ?? artifact.path
    );
  }

  if (artifact.type === "query" && artifact.statement) {
    const result = await diagnoseQuery(
      client,
      artifact.statement,
      options.defaultDatabase
    );
    const run = diagnosisToRun(
      result,
      options.source,
      options.path ?? artifact.path
    );
    const readPaths = await checkReadPaths(
      client,
      result,
      options.projectConfig,
      options.defaultDatabase,
      options.env ?? process.env
    );
    return appendReadPathFindings(run, readPaths);
  }

  if (artifact.type === "query_pair" && artifact.left && artifact.right) {
    const result = await verifyEquivalent(client, {
      left: artifact.left,
      right: artifact.right
    });
    return equivalentToRun(result, {
      left: artifact.left,
      right: artifact.right,
      source: options.source,
      path: options.path ?? artifact.path
    });
  }

  return unknownArtifactRun(
    {
      ...artifact,
      reason:
        "Artifact was classified but did not include the content needed to verify it."
    },
    options
  );
}

function planOnlyRun(
  artifact: ClassifiedArtifact,
  options: PlanOptions
): VerificationRun {
  const capabilities = detectCapabilities({
    ...options,
    gozzleConfig: Boolean(options.projectConfig),
    tableAssumptions:
      Boolean(options.projectConfig) &&
      Object.keys(options.projectConfig?.assumptions ?? {}).length > 0
  });
  const supported = CHECK_REGISTRY.filter((check) =>
    check.supports({
      artifact,
      defaultDatabase: options.defaultDatabase,
      strict: options.strict ?? false,
      capabilities
    })
  );
  const statement =
    artifact.statement ??
    `${artifact.left ?? ""}\n---\n${artifact.right ?? ""}`;

  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    artifact: {
      type: artifact.type,
      source: options.source,
      path: options.path ?? artifact.path,
      fingerprint: fingerprint(statement)
    },
    verdict: "indeterminate",
    severity: "info",
    confidence: "metadata",
    confidenceByCategory: { coverage: "metadata" },
    coverage: {
      scope: "unknown",
      note: "Plan only; no verification checks were executed."
    },
    plan: {
      selectedStrategies: [
        ...new Set(
          supported.flatMap(
            (check) =>
              check.estimate({
                artifact,
                defaultDatabase: options.defaultDatabase,
                strict: options.strict ?? false,
                capabilities
              }).strategies
          )
        )
      ],
      skippedStrategies: capabilities.missing.map((missing) => ({
        strategy:
          missing.capability === "local_chdb"
            ? "local_slice_exact"
            : "advisory",
        reason: missing.reason
      })),
      executedChecks: supported.map((check) => check.id)
    },
    findings: [],
    limits: [
      { type: "advisory_only", message: "Plan-only mode was requested." }
    ],
    recommendations: [],
    productionExecuted: false
  };
}

function appendReadPathFindings(
  run: VerificationRun,
  readPaths: ReadPathOutcome[]
): VerificationRun {
  if (readPaths.length === 0) return run;

  const findings: Finding[] = [...run.findings];
  const limits: Limit[] = [...run.limits];
  for (const readPath of readPaths) {
    if (readPath.status === "violated") {
      findings.push({
        id: "read_path_uniqueness_violated",
        title: "Read path trusts violated uniqueness",
        severity: "error",
        verdict: "fail",
        category: "correctness",
        evidenceLevel: "exact",
        strategy: "production_exact",
        message: readPath.message,
        evidence: [
          { label: "table", value: readPath.table },
          { label: "uniqueBy", value: readPath.uniqueBy.join(", ") },
          { label: "duplicateRows", value: readPath.duplicateRows }
        ],
        limits: [],
        recommendation:
          "Use FINAL, fix ingestion deduplication, or update the table assumption.",
        blocking: true
      });
    } else if (readPath.status === "unknown") {
      limits.push({
        type: "budget",
        message: readPath.message
      });
    }
  }

  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarning =
    findings.some((finding) => finding.severity === "warn") ||
    limits.some((limit) => limit.type === "budget");
  const verdict = hasError ? "fail" : hasWarning ? "warn" : run.verdict;
  return {
    ...run,
    verdict,
    severity:
      verdict === "fail"
        ? "error"
        : verdict === "warn" || verdict === "indeterminate"
          ? "warn"
          : run.severity,
    confidenceByCategory: {
      ...run.confidenceByCategory,
      correctness: hasError ? "exact" : run.confidenceByCategory.correctness
    },
    plan: {
      ...run.plan,
      executedChecks: [...run.plan.executedChecks, "read_path_safety"]
    },
    findings,
    limits,
    recommendations: [
      ...new Set([
        ...run.recommendations,
        ...readPaths
          .filter((readPath) => readPath.status === "violated")
          .map(
            () =>
              "Use FINAL, fix ingestion deduplication, or update the table assumption."
          )
      ])
    ]
  };
}

function unknownArtifactRun(
  artifact: ClassifiedArtifact,
  options: PlanOptions
): VerificationRun {
  const statement =
    artifact.statement ??
    `${artifact.left ?? ""}\n---\n${artifact.right ?? ""}`;
  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    artifact: {
      type: "unknown",
      source: options.source,
      path: options.path ?? artifact.path,
      fingerprint: fingerprint(statement)
    },
    verdict: "indeterminate",
    severity: "warn",
    confidence: "advisory",
    confidenceByCategory: { coverage: "advisory" },
    coverage: { scope: "unknown", note: artifact.reason },
    plan: {
      selectedStrategies: ["static_parse"],
      skippedStrategies: [],
      executedChecks: ["artifact_classification"]
    },
    findings: [],
    limits: [
      {
        type: "unsupported_syntax",
        message: artifact.reason ?? "Artifact type is not supported."
      }
    ],
    recommendations: [
      "Submit one SELECT/WITH query, one ALTER migration, or a before/after query pair."
    ],
    productionExecuted: false
  };
}
