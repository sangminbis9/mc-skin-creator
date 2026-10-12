import { mkdirSync, mkdtempSync } from "node:fs";

/** Reserve a new directory; even an explicit override must never reuse evidence. */
export function freshAuditOutput(prefix: string, override?: string): string {
  if (override !== undefined) {
    if (!override.trim()) throw new Error("empty_audit_output_override");
    mkdirSync(override); // non-recursive, atomic EEXIST for a consumed root
    return override;
  }
  return mkdtempSync(prefix);
}
