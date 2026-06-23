/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RESOURCE_LIMIT =
  /max_execution_time|TIMEOUT_EXCEEDED|Limit for|too many|memory limit/i;

/**
 * True when a ClickHouse error reflects a cost/scan guardrail tripping
 * (timeout, row/byte read limit, memory) rather than a query defect — the
 * signal to fall back to a scoped or sampled path instead of failing outright.
 */
export function isResourceLimitError(error: unknown): boolean {
  return RESOURCE_LIMIT.test(errorMessage(error));
}
