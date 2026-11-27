/**
 * What `latest` in `.kit.toml [tools]` means when kit installs a tool through mise.
 *
 * `latest` stays valid as policy in `.kit.toml`. For an `npm:`, `pipx:` or `pip:` tool it means
 * "the newest stable release that has been public for the cooling period" (`[supply_chain]
 * min_release_age_days`, default 14), the same version the triage cooling line names. kit resolves
 * it to that exact version before it calls mise, and never hands mise the word `latest` for those
 * backends. When it cannot resolve one (registry unreadable, air-gap with no mirror, nothing old
 * enough), the install is refused: there is no fallback to `latest`.
 *
 * Why: mise resolves `latest` for an `npm:` tool by running `npm view <pkg> dist-tags --json`
 * with the `npm` first on PATH (mise v2026.6.11, `src/backend/npm.rs`, `latest_stable_version`).
 * When that `npm` is mise's own shim, the shim resolves the toolset again, which runs `npm view`
 * again: unbounded recursion. With a flaky network nothing is cached, and one machine collected
 * 4,425 orphaned `npm view` processes in under a minute. Newer mise reads the registry over HTTP
 * and skips its own shims, but kit cannot rely on the user's mise version. mise's `pipx:` backend
 * reads PyPI over HTTP in both versions, so it has no such loop; it is resolved here anyway, so
 * that `latest` has one meaning for every backend the cooling resolver supports.
 *
 * Other backends (`aqua:`, `ubi:`, core runtimes such as `node`) pass through unchanged: mise
 * resolves their `latest` from its own registry or the GitHub API, not through a shim, and kit has
 * no cooling resolver for them.
 */
import { triageTargetFor } from "./triage-gate.js";
import {
  defaultCoolingDeps,
  limitFrom,
  newestOlder,
  npmName,
  registrySource,
  supplyChainConfig,
  type CoolingDeps,
} from "./triage-cooling.js";
import { pipName } from "./triage-cooling-pypi.js";

export type MiseVersion =
  /** An exact pin or range from `.kit.toml`, handed to mise as it stands. */
  | { kind: "pinned"; version: string }
  /** `latest` resolved to the newest cooled release. */
  | { kind: "resolved"; version: string; detail: string }
  /** A backend this resolver does not cover; mise resolves `latest` itself without a shim. */
  | { kind: "passthrough"; version: string }
  /** `latest` could not be resolved. The caller must not install. */
  | { kind: "refused"; reason: string };

function refused(tool: string, why: string): MiseVersion {
  return {
    kind: "refused",
    reason: `cannot resolve "latest" for ${tool}: ${why}. kit never hands "latest" to mise for this backend; pin an exact version in .kit.toml [tools]`,
  };
}

/** Resolve the version kit hands to mise for `tool`. Network only through `deps.getJson`. */
export async function resolveMiseVersion(
  tool: string,
  requested: string,
  cwd: string = process.cwd(),
  deps: CoolingDeps = defaultCoolingDeps,
): Promise<MiseVersion> {
  if (requested.trim() !== "latest") return { kind: "pinned", version: requested };
  const t = triageTargetFor(tool);
  if (t.kind !== "triage" || (t.type !== "npm" && t.type !== "pip")) {
    return { kind: "passthrough", version: requested };
  }
  const pkg = t.type === "npm" ? npmName(t.target) : pipName(t.target);
  if (!pkg) return refused(tool, "the package name cannot be read from the reference");
  const limit = limitFrom(await supplyChainConfig(cwd), deps.env);
  const source = registrySource(t.type, pkg, deps, await deps.airGap(cwd));
  if ("skip" in source) return refused(tool, source.skip);
  const view = source.parse(await deps.getJson(source.url));
  if (!view) return refused(tool, "the registry could not be read");
  const version = newestOlder(view.versions, view.times, limit, deps.now());
  if (!version) {
    return refused(tool, `no stable release of ${pkg} has been public for ${limit} days or more`);
  }
  return {
    kind: "resolved",
    version,
    detail: `latest = newest ${pkg} release public for ${limit} days or more: ${version}`,
  };
}
