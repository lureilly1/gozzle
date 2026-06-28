export type Capability =
  | "clickhouse_connection"
  | "readonly_session"
  | "system_parts"
  | "system_columns"
  | "system_query_log"
  | "explain_indexes"
  | "explain_projections"
  | "local_chdb"
  | "git_base"
  | "gozzle_config"
  | "table_assumptions";

export interface MissingCapability {
  capability: Capability;
  reason: string;
}

export interface CapabilitySet {
  available: Set<Capability>;
  missing: MissingCapability[];
}

export interface CapabilityOptions {
  localChdb?: boolean;
  gitBase?: boolean;
  gozzleConfig?: boolean;
  tableAssumptions?: boolean;
}

export function detectCapabilities(
  options: CapabilityOptions = {}
): CapabilitySet {
  const available = new Set<Capability>([
    "clickhouse_connection",
    "readonly_session",
    "system_parts",
    "system_columns",
    "explain_indexes",
    "explain_projections"
  ]);

  if (options.localChdb) available.add("local_chdb");
  if (options.gitBase) available.add("git_base");
  if (options.gozzleConfig) available.add("gozzle_config");
  if (options.tableAssumptions) available.add("table_assumptions");

  const optional: Array<[Capability, boolean, string]> = [
    [
      "system_query_log",
      false,
      "Workload history is not required by the initial planner."
    ],
    [
      "local_chdb",
      Boolean(options.localChdb),
      "Local slice escalation was not enabled."
    ],
    ["git_base", Boolean(options.gitBase), "No git base ref was provided."],
    [
      "gozzle_config",
      Boolean(options.gozzleConfig),
      "No project config was loaded."
    ],
    [
      "table_assumptions",
      Boolean(options.tableAssumptions),
      "No table assumptions were loaded."
    ]
  ];

  return {
    available,
    missing: optional
      .filter(
        ([capability, isAvailable]) =>
          !isAvailable && !available.has(capability)
      )
      .map(([capability, , reason]) => ({ capability, reason }))
  };
}
