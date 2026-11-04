/**
 * Z3, global packages. `kit check` scanned the lockfiles of the project and never looked at what is
 * installed globally: `npm`, `corepack` and every `npm i -g` package sit in each Node install's
 * `lib/node_modules`, run with the user's rights, and no lockfile names them.
 *
 * This reads those folders, so finding the packages executes nothing, builds a synthetic
 * package-lock.json from them in a private temporary folder, and asks osv-scanner about it: the same
 * scanner and the same severity rules as the dependency row. The row says where each vulnerable
 * package lives and prints the global update as text. It never runs it.
 *
 * A package linked from elsewhere (`npm link`) is a symbolic link and is skipped: its version is
 * whatever the linked folder holds. Volta keeps global packages in its own layout and is not read.
 * Kit's own tools (the scanners kit installs through mise) are not covered here. Node only, and not
 * read on Windows.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseOsvVulnCount } from "./check-security.js";
import type { SecurityCheckResult } from "./check-security.js";
import { inventoryNodeInstalls } from "./check-installs.js";
import type { InstallEntry, InstallRoots } from "./check-installs.js";
import { osvFinding } from "./osv-summary.js";
import { airGapView } from "./triage-cooling.js";
import type { AirGapView } from "./triage-cooling.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { detectRuntimes } from "./upstream-runtimes.js";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";

export interface GlobalPackage {
  name: string;
  version: string;
  /** Where it lives, for the report: `mise node 22.23.4`, `npm prefix`. */
  where: string[];
}

const NAME = "global npm packages";
const NPM_NAME = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const MAX_PER_FOLDER = 500;
const MAX_UPDATE_NAMES = 5;
const base = { category: "supply-chain", name: NAME } as const;

/** Printable ASCII on one line: a folder name must not forge a line of the report. */
function plain(value: unknown, max = 80): string {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max);
}

function realFolders(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        const info = lstatSync(join(dir, name));
        return info.isDirectory() && !info.isSymbolicLink();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function readPackage(dir: string, expected: string): { name: string; version: string } | null {
  try {
    const text = readRegularFileIfPresent(join(dir, "package.json"));
    if (text === null) return null;
    const manifest = JSON.parse(text) as { name?: unknown; version?: unknown };
    const name = manifest.name;
    const version = manifest.version;
    const ok =
      typeof name === "string" &&
      name === expected &&
      typeof version === "string" &&
      VERSION.test(version);
    return ok ? { name, version } : null;
  } catch {
    return null;
  }
}

/** The packages directly under one `node_modules`, scoped ones included. */
function packagesIn(modules: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const entry of realFolders(modules).slice(0, MAX_PER_FOLDER)) {
    const candidates = entry.startsWith("@")
      ? realFolders(join(modules, entry)).map((sub) => `${entry}/${sub}`)
      : [entry];
    for (const name of candidates) {
      if (!NPM_NAME.test(name)) continue;
      const found = readPackage(join(modules, name), name);
      if (found) out.push(found);
    }
  }
  return out;
}

interface ModuleDir {
  dir: string;
  where: string;
}

/** The `node_modules` folders that hold global packages, by manager layout. Volta is not read. */
function moduleDirs(roots: InstallRoots, installs: InstallEntry[]): ModuleDir[] {
  const out: ModuleDir[] = [];
  for (const e of installs) {
    const label = `${e.manager} node ${plain(e.version, 20)}`;
    if (e.manager === "mise" || e.manager === "nvm" || e.manager === "system") {
      out.push({ dir: join(e.dir, "lib", "node_modules"), where: label });
    } else if (e.manager === "fnm") {
      out.push({ dir: join(e.dir, "installation", "lib", "node_modules"), where: label });
    } else if (e.manager === "homebrew") {
      out.push({
        dir: join(dirname(dirname(dirname(e.dir))), "lib", "node_modules"),
        where: label,
      });
    }
  }
  const prefix = npmPrefix(roots);
  if (prefix) out.push({ dir: join(prefix, "lib", "node_modules"), where: "npm prefix" });
  return out;
}

const HOME_VARIABLE = "$" + "{HOME}";

/** The prefix `npm i -g` installs under, from the environment or from a `prefix=` line in ~/.npmrc. */
function npmPrefix(roots: InstallRoots): string | null {
  const env = roots.env;
  const fromEnv = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  if (fromEnv) return fromEnv;
  try {
    const text = readRegularFileIfPresent(join(roots.home, ".npmrc"));
    const line = text?.split("\n").find((l) => l.trim().startsWith("prefix"));
    const raw = line?.split("=").slice(1).join("=").trim();
    if (!raw) return null;
    const home = env.HOME || roots.home;
    const expanded = raw.split(HOME_VARIABLE).join(home);
    return expanded.startsWith("~") ? home + expanded.slice(1) : expanded;
  } catch {
    return null;
  }
}

/** Every global package, once, with every place it lives. Reads folders only. */
export function inventoryGlobalPackages(
  roots: InstallRoots,
  installs: InstallEntry[],
): GlobalPackage[] {
  const byKey = new Map<string, GlobalPackage>();
  const seen = new Set<string>();
  for (const { dir, where } of moduleDirs(roots, installs)) {
    for (const p of packagesIn(dir)) {
      const key = `${p.name}@${p.version}`;
      const known = byKey.get(key);
      const stamp = `${dir}\u0000${key}`;
      if (seen.has(stamp)) continue;
      seen.add(stamp);
      if (known) known.where.push(where);
      else byKey.set(key, { name: p.name, version: p.version, where: [where] });
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A package-lock.json (v3) for osv-scanner. A second version of one name is nested so the keys differ. */
export function syntheticLockfile(pkgs: GlobalPackage[]): string {
  const packages: Record<string, unknown> = { "": { name: "kit-global-packages" } };
  const used = new Set<string>();
  pkgs.forEach((p, i) => {
    if (!NPM_NAME.test(p.name) || !VERSION.test(p.version)) return;
    const flat = `node_modules/${p.name}`;
    const key = used.has(p.name) ? `node_modules/__kit_global_${i}/${flat}` : flat;
    used.add(p.name);
    packages[key] = { version: p.version };
  });
  return `${JSON.stringify({ name: "kit-global-packages", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

function unverified(why: string, suggestion?: string): SecurityCheckResult {
  return {
    ...base,
    status: "warn",
    severity: "medium",
    detail: `unverified: ${plain(why, 200)}`,
    ...(suggestion ? { suggestion } : {}),
  };
}

function whereText(pkgs: GlobalPackage[], affected: { name: string; version: string }[]): string {
  return affected
    .slice(0, 6)
    .map((a) => {
      const hit = pkgs.find((p) => p.name === a.name && p.version === a.version);
      const places = hit
        ? hit.where
            .slice(0, 3)
            .map((w) => plain(w, 40))
            .join(", ")
        : "?";
      return `${plain(a.name, 60)} ${plain(a.version, 20)} in ${places}`;
    })
    .join("; ");
}

/** The verdict for the packages and the scanner output. Pure. */
export function judgeGlobalPackages(
  pkgs: GlobalPackage[],
  osvStdout: string | null,
): SecurityCheckResult {
  if (pkgs.length === 0) {
    return {
      ...base,
      status: "skip",
      detail: "no global npm packages found in the Node installs or the npm prefix",
    };
  }
  if (osvStdout === null)
    return unverified(`osv-scanner gave no result for ${pkgs.length} global npm packages`);
  const count = parseOsvVulnCount(osvStdout);
  if (count < 0)
    return unverified(
      `osv-scanner output could not be read for ${pkgs.length} global npm packages`,
    );
  if (count === 0) {
    return {
      ...base,
      status: "pass",
      detail: `${pkgs.length} global npm packages, none with a known vulnerability`,
    };
  }
  const finding = osvFinding(NAME, osvStdout);
  const affected = finding.affected ?? [];
  const names = [...new Set(affected.map((a) => a.name))].filter((n) => NPM_NAME.test(n));
  const detail = finding.detail.replace(/\s*-run: osv-scanner -r \.$/, "");
  return {
    ...finding,
    detail: `${detail}. Where: ${whereText(pkgs, affected)}`,
    suggestion: names.length
      ? names
          .slice(0, MAX_UPDATE_NAMES)
          .map((n) => `npm install -g ${n}@latest`)
          .join("; ")
      : undefined,
  };
}

export interface GlobalDeps {
  platform: string;
  roots: InstallRoots;
  installs: (roots: InstallRoots) => InstallEntry[];
  packages: (roots: InstallRoots, installs: InstallEntry[]) => GlobalPackage[];
  detectNode: (root: string) => { declared: string | null } | null;
  osvBin: () => Promise<string | null>;
  runOsv: (bin: string, dir: string) => Promise<{ stdout: string; code: number }>;
  airGap: (cwd: string) => Promise<AirGapView>;
}

function defaultDeps(): GlobalDeps {
  const env = process.env;
  const prefixes = [
    "/opt/homebrew",
    "/usr/local",
    ...(env.HOMEBREW_PREFIX ? [env.HOMEBREW_PREFIX] : []),
  ];
  return {
    platform: process.platform,
    roots: { home: env.HOME ?? "", env, brewPrefixes: prefixes, systemPrefix: "/usr/local" },
    installs: inventoryNodeInstalls,
    packages: inventoryGlobalPackages,
    detectNode: (root) => detectRuntimes(root).find((r) => r.id === "node") ?? null,
    osvBin: () => resolveToolBin("osv-scanner"),
    runOsv: async (bin, dir) => {
      const r = await execFileNoThrow(bin, ["--format", "json", "-r", "."], {
        timeout: 120_000,
        cwd: dir,
      });
      return { stdout: r.stdout, code: r.exitCode };
    },
    airGap: airGapView,
  };
}

async function scan(bin: string, pkgs: GlobalPackage[], d: GlobalDeps): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "kit-global-packages-"));
  try {
    writeFileSync(join(dir, "package-lock.json"), syntheticLockfile(pkgs), { mode: 0o600 });
    return (await d.runOsv(bin, dir)).stdout;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The global packages row for a project that uses Node. Nothing for one that does not. */
export async function checkGlobalPackages(
  root: string,
  deps?: Partial<GlobalDeps>,
): Promise<SecurityCheckResult[]> {
  const d: GlobalDeps = { ...defaultDeps(), ...deps };
  if (d.detectNode(root) === null) return [];
  if (d.platform === "win32") {
    return [{ ...base, status: "skip", detail: "global packages are not read on Windows yet" }];
  }
  const pkgs = d.packages(d.roots, d.installs(d.roots));
  if (pkgs.length === 0) return [judgeGlobalPackages(pkgs, null)];
  if ((await d.airGap(root)).enabled) {
    return [
      unverified(
        `air-gap is on, so the advisories of ${pkgs.length} global npm packages are not queried`,
      ),
    ];
  }
  const bin = await d.osvBin();
  if (!bin) {
    const why = `osv-scanner is not installed, so ${pkgs.length} global npm packages are not scanned`;
    return [
      unverified(
        why,
        "Install osv-scanner (mise use aqua:google/osv-scanner) and run kit check again",
      ),
    ];
  }
  return [judgeGlobalPackages(pkgs, await scan(bin, pkgs, d))];
}
