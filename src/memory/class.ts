/**
 * kit — memory classification (issue #348).
 *
 * A memory row carries a sensitivity CLASS so a more restrictive memory can never be
 * recalled into a less restrictive context. Without this, one store shared across
 * projects/devices means a note captured in a restricted codebase can surface while you
 * work in a public one — the leak this closes.
 *
 * Label source (the decision that unblocked #348): a **config default** with a
 * **per-project override**. `[memory] default_class` in `.kit.toml` sets it; because kit
 * loads the project's own `.kit.toml`, a project overrides the inherited default simply by
 * declaring its own. `KIT_MEMORY_CLASS` overrides both for an ephemeral session.
 *
 * Fail-closed rules, deliberately asymmetric:
 *   - A **missing** config value is not a security event → the documented default
 *     (`internal`). Silently jumping to `restricted` would break every existing store.
 *   - An **invalid** config value IS a security event (a typo must not silently widen
 *     disclosure) → `restricted`, with `recognized: false` so the caller can surface it.
 *   - A row whose stored class is missing/unrecognized at DISCLOSURE time → treated as
 *     `restricted`. An unclassifiable row is never handed to a lesser context.
 *
 * Everything here is a pure function of its inputs — no DB, no I/O — so the policy is
 * unit-testable on its own.
 */

/** Sensitivity classes, ordered least → most restrictive. The order IS the policy. */
export const MEMORY_CLASSES = ["public", "internal", "restricted"] as const;

export type MemoryClass = (typeof MEMORY_CLASSES)[number];

/** The documented default when nothing is configured. */
export const DEFAULT_MEMORY_CLASS: MemoryClass = "internal";

/** The fail-closed class: what anything unclassifiable is treated as. */
export const MOST_RESTRICTIVE_CLASS: MemoryClass = "restricted";

/** Rank of a class — higher means more restrictive. Total order over MEMORY_CLASSES. */
export function classRank(c: MemoryClass): number {
  return MEMORY_CLASSES.indexOf(c);
}

export function isMemoryClass(v: unknown): v is MemoryClass {
  return typeof v === "string" && (MEMORY_CLASSES as readonly string[]).includes(v);
}

/**
 * Parse a class label of unknown provenance (config value, DB column, synced row).
 * `recognized` is false when the input was present but not a known class — the caller
 * decides whether that is worth surfacing; the returned class already failed closed.
 */
export function parseMemoryClass(raw: unknown): { cls: MemoryClass; recognized: boolean } {
  if (isMemoryClass(raw)) return { cls: raw, recognized: true };
  return { cls: MOST_RESTRICTIVE_CLASS, recognized: false };
}

export interface ClassResolution {
  cls: MemoryClass;
  /** Where the value came from — surfaced so an operator can see why a class applies. */
  source: "env" | "config" | "default";
  /** False when a value was present but invalid (⇒ failed closed to restricted). */
  recognized: boolean;
}

/**
 * Resolve the effective class for capture and for recall context.
 * Precedence: `KIT_MEMORY_CLASS` (explicit, ephemeral) → `[memory] default_class`
 * (config; per-project because the project's own `.kit.toml` is what gets loaded) →
 * `internal` (documented default).
 *
 * An absent value is NOT an error (falls through). A present-but-invalid value fails
 * closed to `restricted` and reports `recognized: false`.
 */
export function resolveMemoryClass(opts: {
  env?: string | undefined;
  configured?: unknown;
}): ClassResolution {
  const env = typeof opts.env === "string" ? opts.env.trim() : "";
  if (env) {
    const p = parseMemoryClass(env);
    return { cls: p.cls, source: "env", recognized: p.recognized };
  }
  if (opts.configured !== undefined && opts.configured !== null && opts.configured !== "") {
    const p = parseMemoryClass(opts.configured);
    return { cls: p.cls, source: "config", recognized: p.recognized };
  }
  return { cls: DEFAULT_MEMORY_CLASS, source: "default", recognized: true };
}

/**
 * May a row of class `rowClass` be disclosed into a context cleared for `contextClass`?
 * Only when the row is no more restrictive than the context. This is the whole gate:
 * `restricted` never flows into `internal` or `public`.
 */
export function classPermitsDisclosure(rowClass: MemoryClass, contextClass: MemoryClass): boolean {
  return classRank(rowClass) <= classRank(contextClass);
}

/**
 * The classes a context may see, for use in a SQL `IN (…)` filter. A NULL/unrecognized
 * stored class is absent from this list by construction, so it fails the `IN` test and is
 * excluded — fail-closed without a special case.
 */
export function disclosableClasses(contextClass: MemoryClass): MemoryClass[] {
  return MEMORY_CLASSES.filter((c) => classPermitsDisclosure(c, contextClass));
}
