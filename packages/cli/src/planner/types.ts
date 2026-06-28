import type { ClickHouseMetadataClient } from "../clickhouse/client.js";
import type {
  Finding,
  VerificationRun,
  VerificationStrategy
} from "../shared/verdict.js";
import type { ClassifiedArtifact } from "./artifacts.js";
import type { CapabilitySet } from "./capabilities.js";

export type VerificationIntent =
  | "correctness"
  | "equivalence"
  | "cost_risk"
  | "read_path_safety"
  | "dedup_safety"
  | "migration_risk";

export interface PlannerContext {
  artifact: ClassifiedArtifact;
  defaultDatabase: string;
  strict: boolean;
  capabilities: CapabilitySet;
}

export interface PlannerExecutionContext extends PlannerContext {
  client: ClickHouseMetadataClient;
  source: VerificationRun["artifact"]["source"];
}

export interface CheckEstimate {
  checkId: string;
  strategies: VerificationStrategy[];
  shouldRun: boolean;
  reason?: string;
}

export interface CheckDefinition {
  id: string;
  intents: VerificationIntent[];
  supports(context: PlannerContext): boolean;
  estimate(context: PlannerContext): CheckEstimate;
  execute(context: PlannerExecutionContext): Promise<Finding[]>;
}
