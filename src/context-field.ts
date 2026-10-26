import type { ContextConfig } from "./config.js";
import type { ContextFinding } from "./context-lock.js";

/**
 * Compare one declared value (or list of exact names) with the live value. A list is a set of
 * exact names, never patterns: `acme-*` would also match `acme-prod-old`. An empty list matches
 * nothing. Undeclared means not checked.
 */
export function field(
  tool: string,
  name: string,
  declared: string | string[] | undefined,
  actual: string | null,
): ContextFinding | null {
  if (declared === undefined) return null;
  const names = Array.isArray(declared) ? declared : [declared];
  const expected = Array.isArray(declared) ? names.join(" | ") || "(empty list)" : declared;
  if (actual === null) return { tool, field: name, status: "unknown", expected, actual: null };
  const status = names.includes(actual) ? "ok" : "mismatch";
  return { tool, field: name, status, expected, actual };
}

/** The one project `kit context use` may activate. A list of several names no single project. */
export function activationProject(g: ContextConfig["gcloud"]): string | undefined {
  const p = g?.project;
  if (!Array.isArray(p)) return p;
  return p.length === 1 ? p[0] : undefined;
}
