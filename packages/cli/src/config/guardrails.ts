export interface GuardrailConfig {
  /** Enforce a read-only session (readonly=2) so no query can write. */
  enforceReadonly: boolean;
  /** Hard wall-clock cap per query, in seconds. 0 disables. */
  maxExecutionTimeSeconds: number;
  /** Cap rows returned to gozzle. 0 disables. gozzle only needs verdicts. */
  maxResultRows: number;
  /** Cap rows a query may read before it is aborted. 0 disables. */
  maxRowsToRead: number;
  /** Cap bytes a query may read before it is aborted. 0 disables. */
  maxBytesToRead: number;
}

export interface GuardrailEnv {
  GOZZLE_ENFORCE_READONLY?: string;
  GOZZLE_MAX_EXECUTION_TIME?: string;
  GOZZLE_MAX_RESULT_ROWS?: string;
  GOZZLE_MAX_ROWS_TO_READ?: string;
  GOZZLE_MAX_BYTES_TO_READ?: string;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  enforceReadonly: true,
  maxExecutionTimeSeconds: 30,
  maxResultRows: 10000,
  maxRowsToRead: 0,
  maxBytesToRead: 0
};

export function readGuardrailConfig(
  env: GuardrailEnv = process.env
): GuardrailConfig {
  return {
    enforceReadonly: readBoolean(
      env.GOZZLE_ENFORCE_READONLY,
      DEFAULT_GUARDRAILS.enforceReadonly
    ),
    maxExecutionTimeSeconds: readNonNegativeInt(
      env.GOZZLE_MAX_EXECUTION_TIME,
      DEFAULT_GUARDRAILS.maxExecutionTimeSeconds
    ),
    maxResultRows: readNonNegativeInt(
      env.GOZZLE_MAX_RESULT_ROWS,
      DEFAULT_GUARDRAILS.maxResultRows
    ),
    maxRowsToRead: readNonNegativeInt(
      env.GOZZLE_MAX_ROWS_TO_READ,
      DEFAULT_GUARDRAILS.maxRowsToRead
    ),
    maxBytesToRead: readNonNegativeInt(
      env.GOZZLE_MAX_BYTES_TO_READ,
      DEFAULT_GUARDRAILS.maxBytesToRead
    )
  };
}

/**
 * Translate the guardrail config into ClickHouse session settings applied to
 * every query gozzle runs.
 */
export function toClickHouseSettings(
  guardrails: GuardrailConfig
): Record<string, string> {
  const settings: Record<string, string> = {};

  if (guardrails.enforceReadonly) {
    // readonly=2 forbids writes and DDL while still allowing SELECT/SHOW and
    // the per-query settings below.
    settings.readonly = "2";
  }

  if (guardrails.maxExecutionTimeSeconds > 0) {
    settings.max_execution_time = String(guardrails.maxExecutionTimeSeconds);
  }

  if (guardrails.maxResultRows > 0) {
    settings.max_result_rows = String(guardrails.maxResultRows);
    settings.result_overflow_mode = "throw";
  }

  if (guardrails.maxRowsToRead > 0) {
    settings.max_rows_to_read = String(guardrails.maxRowsToRead);
    settings.read_overflow_mode = "throw";
  }

  if (guardrails.maxBytesToRead > 0) {
    settings.max_bytes_to_read = String(guardrails.maxBytesToRead);
    settings.read_overflow_mode = "throw";
  }

  return settings;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function readNonNegativeInt(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}
