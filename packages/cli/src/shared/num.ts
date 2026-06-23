/** A numeric column as ClickHouse returns it over JSON (64-bit ints arrive as strings). */
export type ChNumeric = string | number;

/** Coerce a ClickHouse numeric value to a JS number, defaulting to 0. */
export function toNumber(value: ChNumeric): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
