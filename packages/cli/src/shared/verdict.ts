// The shared verdict contract every gozzle check reports against. `correct` is
// reserved for EXACT methods: a sample can prove `incorrect` but never
// `correct`.
export type Verdict =
  | "correct"
  | "incorrect"
  | "likely-correct"
  | "indeterminate";

export type VerifyMethod = "exact-source" | "exact-replica" | "sampled";

export interface Coverage {
  scope: "table" | "partition" | "sample";
  rowsCompared?: number;
  note?: string;
}

/** Map a verdict to a process exit code for CLI/CI gating. */
export function verdictExitCode(verdict: Verdict): 0 | 1 | 2 {
  if (verdict === "correct" || verdict === "likely-correct") return 0;
  if (verdict === "incorrect") return 1;
  return 2; // indeterminate
}
