/**
 * kit project profile — declared-vs-discovered drift (Pillar 4 step 2).
 * The profile (`schema.ts`) DECLARES the intended toolchain; this module measures how far
 * the actual project has drifted from that declaration. Split in two:
 *
 *   - `computeProfileDrift(declared, actual)` — PURE comparison, fully unit-testable against
 *     fixtures. Same discipline as the insight loop's pure `usage-scan` core.
 *   - `discoverActualState(cwd)` — the thin, best-effort filesystem wiring that gathers the
 *     "actual" snapshot from `discoverAgentToolchain` + `.kit.toml`.
 *
 * Deterministic + zero-LLM: drift is set difference and exact version comparison, never a
 * heuristic that can flimra. No auto-mutation here — this only REPORTS; acting on drift is the
 * operator's call (the `kit profile` command, step 3).
 *
 * HONESTY (no false green): a kind whose actual state cannot be discovered yet (workflows,
 * plugins — their discovery lands in step 4) is reported as UNAUDITED when the profile declares
 * entries for it — never silently counted as "in sync". Unknown ≠ clean.
 */
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { discoverAgentToolchain, discoverPlugins } from "../agent-sbom.js";
import type { KitProfile, ProfileComponent } from "./schema.js";

export type ComponentKind = "skill" | "mcp" | "workflow" | "plugin";

export type DriftStatus = "in-sync" | "version-drift" | "removed" | "added";

export interface DriftEntry {
  kind: ComponentKind;
  name: string;
  status: DriftStatus;
  /** Declared version (if the profile pinned one). */
  declared?: string;
  /** Discovered version (if known). */
  found?: string;
}

export interface VaultDrift {
  status: "in-sync" | "drift";
  declared?: string;
  found?: string;
}

export interface ProfileDrift {
  /** Per-component drift, sorted deterministically (kind, then name, then status). */
  entries: DriftEntry[];
  /** Vault-store drift, or null when the profile declares no store to check. */
  vault: VaultDrift | null;
  /**
   * Component kinds the profile DECLARES but whose actual state can't be discovered yet
   * (reported honestly, never folded into "clean"). Sorted, de-duplicated.
   */
  unaudited: ComponentKind[];
  /** Count of real drifts (entries not in-sync + a vault drift). Unaudited kinds do NOT count. */
  driftCount: number;
  /** True when there is zero measurable drift. Unaudited kinds do not make it dirty. */
  clean: boolean;
}

export interface DiscoveredComponent {
  name: string;
  version?: string;
}

export interface DiscoveredState {
  skills: DiscoveredComponent[];
  mcp: DiscoveredComponent[];
  /** null = discovery for this kind is not available yet (UNKNOWN, not empty). */
  workflows: DiscoveredComponent[] | null;
  plugins: DiscoveredComponent[] | null;
  /** Global vault store from `.kit.toml` `secrets.store`, or undefined if none/unreadable. */
  vaultStore?: string;
}

/** Fixed kind order for stable output. */
const KIND_ORDER: Record<ComponentKind, number> = { skill: 0, mcp: 1, workflow: 2, plugin: 3 };

/** Compare one component kind's declared set against its discovered set. */
function driftForKind(
  kind: ComponentKind,
  declared: ProfileComponent[] | undefined,
  found: DiscoveredComponent[] | null,
): DriftEntry[] {
  const entries: DriftEntry[] = [];
  const declaredList = declared ?? [];
  // Discovery unavailable for this kind — the caller records it as unaudited; emit nothing.
  if (found === null) return entries;

  const foundByName = new Map(found.map((c) => [c.name, c]));
  const declaredNames = new Set(declaredList.map((c) => c.name));

  for (const d of declaredList) {
    const f = foundByName.get(d.name);
    if (!f) {
      entries.push({ kind, name: d.name, status: "removed", declared: d.version });
      continue;
    }
    // Only a real version drift when BOTH sides pin a version and they differ — an unpinned
    // declaration matches any found version (the profile didn't pin it), and an unknown found
    // version can't be called a drift.
    if (d.version && f.version && d.version !== f.version) {
      entries.push({
        kind,
        name: d.name,
        status: "version-drift",
        declared: d.version,
        found: f.version,
      });
    } else {
      entries.push({
        kind,
        name: d.name,
        status: "in-sync",
        declared: d.version,
        found: f.version,
      });
    }
  }

  for (const f of found) {
    if (!declaredNames.has(f.name)) {
      entries.push({ kind, name: f.name, status: "added", found: f.version });
    }
  }

  return entries;
}

/**
 * Pure declared-vs-discovered drift. Same inputs → same output (no clock, no randomness), so
 * it is safe to diff in CI.
 */
export function computeProfileDrift(declared: KitProfile, actual: DiscoveredState): ProfileDrift {
  const entries: DriftEntry[] = [
    ...driftForKind("skill", declared.skills, actual.skills),
    ...driftForKind("mcp", declared.mcp, actual.mcp),
    ...driftForKind("workflow", declared.workflows, actual.workflows),
    ...driftForKind("plugin", declared.plugins, actual.plugins),
  ];

  entries.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name) ||
      a.status.localeCompare(b.status),
  );

  // Unaudited: a kind the profile declares but whose actual state we can't discover.
  const unaudited: ComponentKind[] = [];
  if ((declared.workflows?.length ?? 0) > 0 && actual.workflows === null)
    unaudited.push("workflow");
  if ((declared.plugins?.length ?? 0) > 0 && actual.plugins === null) unaudited.push("plugin");

  let vault: VaultDrift | null = null;
  const declaredStore = declared.vault?.store;
  if (declaredStore !== undefined) {
    vault =
      declaredStore === actual.vaultStore
        ? { status: "in-sync", declared: declaredStore, found: actual.vaultStore }
        : { status: "drift", declared: declaredStore, found: actual.vaultStore };
  }

  const driftCount =
    entries.filter((e) => e.status !== "in-sync").length + (vault?.status === "drift" ? 1 : 0);

  return { entries, vault, unaudited, driftCount, clean: driftCount === 0 };
}

/**
 * Best-effort snapshot of the ACTUAL project state, mirroring `discoverAgentToolchain`'s
 * defensive posture: missing/malformed inputs degrade to "unknown", never throw. Plugins are
 * discovered from `package.json` `kitPlugins` (so plugin drift is auditable); workflows remain
 * `null` — there is no on-disk workflow convention to reconcile against yet, so drift honestly
 * reports declared workflows as unaudited rather than pretending they are absent.
 */
export async function discoverActualState(cwd = process.cwd()): Promise<DiscoveredState> {
  const { skills, mcpServers } = discoverAgentToolchain(cwd);
  const plugins = discoverPlugins(cwd);
  let vaultStore: string | undefined;
  try {
    const cfg = await loadConfig(resolve(cwd, ".kit.toml"));
    vaultStore = cfg.secrets?.store;
  } catch {
    /* no / unreadable .kit.toml — vault store unknown */
  }
  return {
    skills: skills.map((s) => ({ name: s.name, version: s.version })),
    mcp: mcpServers.map((s) => ({ name: s.name, version: s.version })),
    workflows: null,
    plugins: plugins.map((p) => ({ name: p.name, version: p.version })),
    vaultStore,
  };
}
