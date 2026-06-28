import type { CheckDefinition, PlannerContext } from "./types.js";

function directCheck(
  id: CheckDefinition["id"],
  type: PlannerContext["artifact"]["type"],
  strategies: ReturnType<CheckDefinition["estimate"]>["strategies"]
): CheckDefinition {
  return {
    id,
    intents:
      id === "query_equivalence"
        ? ["equivalence"]
        : id === "migration_risk"
          ? ["migration_risk", "correctness"]
          : ["cost_risk"],
    supports: (context) => context.artifact.type === type,
    estimate: (context) => ({
      checkId: id,
      strategies,
      shouldRun: context.artifact.type === type,
      reason:
        context.artifact.type === type
          ? undefined
          : `Artifact type ${context.artifact.type} is not supported by ${id}.`
    }),
    execute: async () => {
      throw new Error(
        `${id} is registered for planning only; execution is currently direct-dispatched by planner.ts.`
      );
    }
  };
}

export const CHECK_REGISTRY: CheckDefinition[] = [
  directCheck("query_diagnosis", "query", [
    "production_explain",
    "static_parse"
  ]),
  directCheck("query_equivalence", "query_pair", ["production_exact"]),
  directCheck("migration_risk", "migration", [
    "metadata_only",
    "production_bounded_probe"
  ])
];
