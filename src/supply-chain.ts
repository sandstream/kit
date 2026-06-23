/**
 * Install-time supply-chain triage — deterministic, local-first checks over a
 * project's `package.json` + `package-lock.json` (no network, no node_modules walk):
 *
 *  - install-scripts : deps that run pre/post/install scripts (the classic malware
 *                      execution vector) — surfaced so they can be reviewed / run
 *                      with `--ignore-scripts`.
 *  - lockfile-drift  : a declared dependency missing from the lockfile, or a package
 *                      resolved from a NON-registry source (http/git/github tarball).
 *  - dep-confusion   : a dependency under one of your declared internal scopes that
 *                      the lockfile resolves from the PUBLIC registry (a name your
 *                      private package shares with a public one).
 *  - slopsquat       : a dependency edit-distance ≤1 from a high-traffic package
 *                      name but not an exact match (a likely look-alike).
 *
 * The check functions are pure (parsed data in → findings out) and fixture-tested;
 * `runSupplyChain` is the thin file-reading wrapper.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { TOP_NPM_SET } from "./data/top-npm.js";

export interface LockPkg {
  /** lockfile key, e.g. "node_modules/lodash" */
  path: string;
  name: string;
  version?: string;
  resolved?: string;
  hasInstallScript?: boolean;
}

const REGISTRY = /registry\.npmjs\.org\//;

/** Packages whose install runs a script (npm lockfile v3 records this). */
export function findInstallScripts(lockPkgs: LockPkg[]): string[] {
  return lockPkgs
    .filter((p) => p.hasInstallScript && p.name)
    .map((p) => (p.version ? `${p.name}@${p.version}` : p.name));
}

/** Declared deps that have no entry in the lockfile (drift / un-pinned). */
export function findLockDrift(declaredDeps: string[], lockNames: Set<string>): string[] {
  return declaredDeps.filter((d) => !lockNames.has(d));
}

/** Packages resolved from a non-registry source (http/git tarball) — supply-chain risk. */
export function findNonRegistryResolved(lockPkgs: LockPkg[]): { name: string; resolved: string }[] {
  return lockPkgs
    .filter(
      (p) =>
        p.resolved && !REGISTRY.test(p.resolved) && /^(https?:|git\+|github:)/.test(p.resolved),
    )
    .map((p) => ({ name: p.name, resolved: p.resolved! }));
}

/** Internal-scoped deps the lockfile resolves from the public registry (confusion risk). */
export function findDepConfusion(
  declaredDeps: string[],
  resolvedByName: Map<string, string | undefined>,
  internalScopes: string[],
): string[] {
  if (internalScopes.length === 0) return [];
  return declaredDeps.filter(
    (d) =>
      internalScopes.some((s) => d === s || d.startsWith(s.endsWith("/") ? s : `${s}/`)) &&
      REGISTRY.test(resolvedByName.get(d) ?? ""),
  );
}

/**
 * Bounded Damerau-Levenshtein (optimal string alignment) — counts substitutions,
 * insertions, deletions, AND adjacent transpositions as single edits, since
 * transpositions (`lodahs` for `lodash`) are a classic typosquat. Stops early
 * once the distance is known to exceed `cap`.
 */
export function editDistance(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1); // transposition
      }
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[m][n];
}

/** Deps that look like a near-miss (≤1 edit, incl. transposition) of a popular package. */
export function findSlopsquat(
  declaredDeps: string[],
  corpus: ReadonlySet<string> = TOP_NPM_SET,
): { name: string; near: string }[] {
  const out: { name: string; near: string }[] = [];
  for (const d of declaredDeps) {
    if (corpus.has(d)) continue; // exact popular package = fine
    for (const c of corpus) {
      if (Math.abs(c.length - d.length) > 1) continue;
      if (editDistance(d, c, 1) === 1) {
        out.push({ name: d, near: c });
        break;
      }
    }
  }
  return out;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface LockfileV3 {
  packages?: Record<
    string,
    { name?: string; version?: string; resolved?: string; hasInstallScript?: boolean }
  >;
}

/** Parse an npm lockfile (v3 `packages` map) into a flat LockPkg list. */
export function parseLockPkgs(lock: LockfileV3): LockPkg[] {
  const out: LockPkg[] = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue; // the root project entry
    const name = meta.name ?? path.split("node_modules/").pop() ?? path;
    out.push({
      path,
      name,
      version: meta.version,
      resolved: meta.resolved,
      hasInstallScript: meta.hasInstallScript,
    });
  }
  return out;
}

function result(
  name: string,
  status: SecurityCheckResult["status"],
  detail: string,
  severity?: SecurityCheckResult["severity"],
  suggestion?: string,
): SecurityCheckResult {
  return { category: "supply-chain", name, status, detail, severity, suggestion };
}

/** Run all four checks against the project at `cwd`. Read-only; fail-open per file. */
export function runSupplyChain(cwd: string, internalScopes: string[] = []): SecurityCheckResult[] {
  let pkg: PackageJson;
  let lock: LockfileV3;
  try {
    pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as PackageJson;
  } catch {
    return [result("supply-chain", "skip", "no package.json found")];
  }
  try {
    lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8")) as LockfileV3;
  } catch {
    return [
      result(
        "lockfile",
        "warn",
        "no package-lock.json — install-time checks need a committed lockfile",
        "medium",
      ),
    ];
  }

  const declared = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const lockPkgs = parseLockPkgs(lock);
  const lockNames = new Set(lockPkgs.map((p) => p.name));
  const resolvedByName = new Map(lockPkgs.map((p) => [p.name, p.resolved] as const));

  const out: SecurityCheckResult[] = [];

  const scripts = findInstallScripts(lockPkgs);
  out.push(
    scripts.length === 0
      ? result("install-scripts", "pass", "no dependencies run install scripts")
      : result(
          "install-scripts",
          "warn",
          `${scripts.length} dep(s) run install scripts: ${scripts.slice(0, 8).join(", ")}${scripts.length > 8 ? "…" : ""}`,
          "medium",
          "review them; install with `npm ci --ignore-scripts` where possible",
        ),
  );

  const drift = findLockDrift(declared, lockNames);
  const nonReg = findNonRegistryResolved(lockPkgs);
  if (drift.length === 0 && nonReg.length === 0) {
    out.push(
      result(
        "lockfile-drift",
        "pass",
        "lockfile covers all declared deps; all resolved from the registry",
      ),
    );
  } else {
    if (drift.length > 0) {
      out.push(
        result(
          "lockfile-drift",
          "warn",
          `${drift.length} declared dep(s) missing from the lockfile: ${drift.slice(0, 8).join(", ")}`,
          "medium",
          "run `npm install` and commit the lockfile",
        ),
      );
    }
    if (nonReg.length > 0) {
      out.push(
        result(
          "lockfile-source",
          "warn",
          `${nonReg.length} package(s) resolved from a non-registry source (${nonReg
            .slice(0, 3)
            .map((n) => n.name)
            .join(", ")})`,
          "high",
          "verify these http/git tarball sources are trusted",
        ),
      );
    }
  }

  const confusion = findDepConfusion(declared, resolvedByName, internalScopes);
  if (internalScopes.length === 0) {
    out.push(
      result(
        "dep-confusion",
        "skip",
        "no internal scopes declared ([supply_chain] internal_scopes)",
      ),
    );
  } else if (confusion.length === 0) {
    out.push(
      result("dep-confusion", "pass", "no internal-scoped dep resolves from the public registry"),
    );
  } else {
    out.push(
      result(
        "dep-confusion",
        "fail",
        `${confusion.length} internal-scoped dep(s) resolved from the PUBLIC registry: ${confusion.join(", ")}`,
        "high",
        "a public package shares your internal name — pin to your private registry",
      ),
    );
  }

  const slop = findSlopsquat(declared);
  out.push(
    slop.length === 0
      ? result("slopsquat", "pass", "no dependency name looks like a popular-package look-alike")
      : result(
          "slopsquat",
          "warn",
          `${slop.length} possible look-alike(s): ${slop
            .slice(0, 5)
            .map((s) => `${s.name}≈${s.near}`)
            .join(", ")}`,
          "high",
          "confirm these are the intended packages, not typosquats",
        ),
  );

  return out;
}
