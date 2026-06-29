/**
 * kit memory — path → cluster (area) push-surfacing (memory design gap #3).
 *
 * Pull recall ("kit memory search") only returns what your QUERY matches, so it
 * can't GUARANTEE you see a settled decision — you might not search the right
 * words. The guardrail must be PUSH: when you touch files under an area, kit
 * DETERMINISTICALLY surfaces that area's ACTIVE decisions. Touch src/memory/** →
 * always see the `memory` area's decisions. Not a query lottery.
 *
 * The map (area → globs) is committed project config (`.kit/shared/clusters.json`,
 * reviewed like the rest of the shared tier). Matching is deterministic glob→regex
 * (zero-dep, no ML). The decisions come from activeShared() so superseded/reversed
 * ones never resurface.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { activeShared, type SharedEntry } from "./shared.js";

/** area → list of globs that belong to it. */
export type ClusterMap = Record<string, string[]>;

export function getClustersPath(root: string): string {
  return join(root, ".kit", "shared", "clusters.json");
}

/** Read + validate the cluster map. Best-effort: {} if absent/malformed. */
export function readClusters(root: string): ClusterMap {
  try {
    const raw = JSON.parse(readFileSync(getClustersPath(root), "utf8")) as Record<string, unknown>;
    const out: ClusterMap = {};
    for (const [area, globs] of Object.entries(raw)) {
      if (Array.isArray(globs)) {
        const strs = globs.filter((g): g is string => typeof g === "string");
        if (strs.length) out[area] = strs;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Compile a glob to an anchored RegExp. `**` spans path segments (incl. `/`),
 * `*` matches within one segment, `?` one non-slash char. `**\/` matches zero or
 * more leading segments so `**\/x` matches both `x` and `a/b/x`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += glob[i].replace(GLOB_SPECIALS, "\\$&");
      i += 1;
    }
  }
  return new RegExp(re + "$");
}

/** Areas whose any glob matches any of the given (repo-relative) paths. Sorted, deduped. */
export function clustersForPaths(map: ClusterMap, paths: string[]): string[] {
  const compiled = Object.entries(map).map(([area, globs]) => ({
    area,
    res: globs.map(globToRegExp),
  }));
  const hit = new Set<string>();
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, "").trim();
    if (!p) continue;
    for (const { area, res } of compiled) {
      if (res.some((r) => r.test(p))) hit.add(area);
    }
  }
  return [...hit].sort();
}

export interface ClusterDecisions {
  area: string;
  decisions: SharedEntry[];
}

/**
 * For the areas the given paths fall into, the ACTIVE shared decisions of each
 * (areas with no active decisions are dropped). This is the push payload.
 */
export function decisionsForPaths(root: string, paths: string[]): ClusterDecisions[] {
  const areas = clustersForPaths(readClusters(root), paths);
  if (!areas.length) return [];
  const active = activeShared(root);
  return areas
    .map((area) => ({ area, decisions: active.filter((e) => e.area === area) }))
    .filter((g) => g.decisions.length > 0);
}

/**
 * Files changed in the working tree vs HEAD (staged + unstaged). The deterministic
 * "what am I touching" signal for push-surfacing. Best-effort: [] outside a repo.
 */
export function changedPaths(root: string): string[] {
  try {
    const out = execFileSync("git", ["-C", root, "diff", "--name-only", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
