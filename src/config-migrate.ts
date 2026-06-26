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
