import { createHash } from "node:crypto";

/** Stable SHA-256 of a SQL statement, for audit logs that must not echo literals. */
export function fingerprint(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}
