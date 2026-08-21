// Deterministic, pure .kit.toml schema migration registry.
//
// This is the "first move" of the config contract freeze: a major kit bump must
// never silently re-interpret an existing user's config. Every breaking shape
// change becomes an ordered data row below. The framework detects the config's
// current version, plans the path of migrations up to CONFIG_SCHEMA_VERSION, and
// applies them in order — all as pure object transforms (no IO), so the file-IO
// layer (commands/config.ts) can back up, write, then re-validate the result.
//
// A config with no [version] field is legacy "v0". v1 is the baseline: the
// v0->v1 migration stamps version=1 and changes no other field. The point is the
// FRAMEWORK, which is real and extensible — a future field rename is one row.
import { CONFIG_SCHEMA_VERSION } from "./config.js";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { parse as parseToml } from "smol-toml";

/** A parsed-but-untyped config object (smol-toml output / Zod input). */
export type RawConfig = Record<string, unknown>;

export interface ConfigMigration {
  /** Schema version this migration upgrades FROM. */
  from: number;
  /** Schema version this migration upgrades TO (must equal from + 1). */
  to: number;
  /** Human-readable summary of what this step changes. */
  describe: string;
  /** Pure transform: returns a NEW object, never mutates the input. */
  apply(cfg: RawConfig): RawConfig;
}

/**
 * Ordered migration registry. Each row upgrades exactly one version step.
 * Keep contiguous (0->1->2->…) so planMigrations can always find a path.
 */
export const MIGRATIONS: ConfigMigration[] = [
  {
    from: 0,
    to: 1,
    describe: "Stamp schema version=1 (baseline; no field renames)",
    apply(cfg) {
      // No-op transform beyond stamping the version. v1 is the current shape.
      return { ...cfg, version: 1 };
    },
  },
];

/**
 * Detect the schema version of a parsed config. Absent / non-integer / negative
 * version => legacy v0 (every config written before versioning existed).
 */
export function detectConfigVersion(cfg: RawConfig): number {
  const v = cfg.version;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  return 0;
}

/**
 * Compute the ordered list of migration steps to get from `from` to `to`.
 * Returns [] when already at the target. Throws on a downgrade (config newer
 * than this kit) or a gap in the registry — fail loud, never corrupt.
 */
export function planMigrations(from: number, to: number): ConfigMigration[] {
  if (from === to) return [];
  if (from > to) {
    throw new Error(
      `Config is at v${from}, newer than this kit's v${to}. Upgrade kit instead of migrating down.`,
    );
  }
  const steps: ConfigMigration[] = [];
  let cursor = from;
  while (cursor < to) {
    const step = MIGRATIONS.find((m) => m.from === cursor);
    if (!step) {
      throw new Error(`No migration registered from config v${cursor} (target v${to}).`);
    }
    if (step.to !== cursor + 1) {
      throw new Error(
        `Migration from v${step.from} must go to v${step.from + 1}, not v${step.to}.`,
      );
    }
    steps.push(step);
    cursor = step.to;
  }
  return steps;
}

export interface MigrationResult {
  /** The migrated config object (input unchanged when no steps applied). */
  migrated: RawConfig;
  /** Detected starting version. */
  fromVersion: number;
  /** Target version (CONFIG_SCHEMA_VERSION unless overridden). */
  toVersion: number;
  /** The steps that were applied, in order. */
  steps: ConfigMigration[];
  /** True when at least one migration step ran. */
  changed: boolean;
}

/**
 * Pure migration of a parsed config object from its detected version up to
 * `target` (default CONFIG_SCHEMA_VERSION). Does not touch the filesystem and
 * does not mutate the input.
 */
export function migrateConfig(
  cfg: RawConfig,
  target: number = CONFIG_SCHEMA_VERSION,
): MigrationResult {
  const fromVersion = detectConfigVersion(cfg);
  const steps = planMigrations(fromVersion, target);
  let migrated: RawConfig = cfg;
  for (const step of steps) {
    migrated = step.apply(migrated);
  }
  return {
    migrated,
    fromVersion,
    toVersion: target,
    steps,
    changed: steps.length > 0,
  };
}

/**
 * Read-only: is the config file on disk behind the current schema?
 *
 * `kit config migrate --check` answered this and nothing called it, so `kit status` said
 * `✓ .kit.toml present` and never that "present" is not "current" (#511). This is the same
 * detection with no write path at all, so a status row can ask cheaply. Returns null when there
 * is no readable config — an absent or malformed config is reported by other rows.
 */
export function planConfigMigration(
  cwd: string = process.cwd(),
): { fromVersion: number; toVersion: number; current: boolean; steps: number } | null {
  try {
    const raw = parseToml(readFileSync(joinPath(cwd, ".kit.toml"), "utf-8")) as RawConfig;
    const fromVersion = detectConfigVersion(raw);
    const steps = planMigrations(fromVersion, CONFIG_SCHEMA_VERSION);
    return {
      fromVersion,
      toVersion: CONFIG_SCHEMA_VERSION,
      current: steps.length === 0,
      steps: steps.length,
    };
  } catch {
    return null;
  }
}

/**
 * Apply a migration by EDITING THE SOURCE TEXT, when the change is only added top-level keys.
 *
 * `stringify(migrated)` re-serialises from the parsed object, so every comment in the file is
 * deleted. Measured on kit's own config, migrating v0 -> v1 — a step whose entire job is to stamp
 * `version = 1`: 8 comment lines became 0, and a one-line change produced a 36-line diff (#513).
 * The data was identical, so re-validation passed and nothing flagged the loss.
 *
 * `.kit.toml` is where a repo declares its policy, and the comments are where the WHY lives —
 * why these scanners, why scheme-qualified refs, which values a field accepts. A routine
 * maintenance command must not convert reviewable policy into bare data.
 *
 * Returns null when the diff is anything more than added top-level scalars, so a future migration
 * that renames or moves keys does NOT get silently patched by a text edit that cannot express it.
 * The caller then falls back to serialising — loudly.
 */
export function patchConfigText(original: string, diff: readonly ConfigDiffEntry[]): string | null {
  const additions = diff.filter((d) => d.before === undefined && d.after !== undefined);
  if (additions.length !== diff.length || additions.length === 0) return null;
  // Only top-level scalars: a dotted path is a nested table, which needs placement rules a
  // line insert cannot get right.
  if (additions.some((d) => d.path.includes("."))) return null;

  // Insert before the first table header so the keys stay top-level (TOML scopes everything
  // after a `[table]` to that table), keeping the original text byte-for-byte otherwise.
  const lines = original.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rendered = additions.map((d) => `${d.path} = ${d.after}`);
  if (firstTable < 0) {
    const body = original.endsWith("\n") ? original : `${original}\n`;
    return `${body}${rendered.join("\n")}\n`;
  }
  const head = lines.slice(0, firstTable);
  // Trim trailing blank lines from the head so the inserted block does not float.
  while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
  const before = head.length > 0 ? [...head, ""] : [];
  return [...before, ...rendered, "", ...lines.slice(firstTable)].join("\n");
}

/** Comment lines in a TOML source — used to report what a serialising migration would delete. */
export function countCommentLines(toml: string): number {
  return toml.split("\n").filter((l) => /^\s*#/.test(l) || /\s#/.test(l)).length;
}

export interface ConfigDiffEntry {
  path: string;
  before: string | undefined;
  after: string | undefined;
}

/**
 * Flatten a config object to dotted-path => scalar string entries, for a
 * deterministic, value-level diff (independent of TOML key ordering).
 */
function flatten(
  obj: RawConfig,
  prefix = "",
  out: Map<string, string> = new Map(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flatten(value as RawConfig, path, out);
    } else {
      out.set(path, JSON.stringify(value));
    }
  }
  return out;
}

/**
 * Value-level diff of two parsed configs (before -> after). Returns sorted
 * entries where a path was added, removed, or changed.
 */
export function diffConfigs(before: RawConfig, after: RawConfig): ConfigDiffEntry[] {
  const a = flatten(before);
  const b = flatten(after);
  const paths = new Set([...a.keys(), ...b.keys()]);
  const entries: ConfigDiffEntry[] = [];
  for (const path of paths) {
    const bv = a.get(path);
    const av = b.get(path);
    if (bv !== av) {
      entries.push({ path, before: bv, after: av });
    }
  }
  entries.sort((x, y) => x.path.localeCompare(y.path));
  return entries;
}
