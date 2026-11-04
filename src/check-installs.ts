/**
 * Z2, all installs. The runtime row judges the one Node that answers `node --version`. A machine
 * with Node 25.8.0 first in PATH and 26.7.0 installed lower down looks fine if only the newer one is
 * read, and the old one is what runs. This lists the installs that mise, Homebrew, nvm, fnm, Volta
 * and a plain /usr/local keep, says which one PATH runs, judges each with the end-of-life and
 * security data the runtime row already reads, and proposes (never runs) removing the ones that are
 * not safe to keep.
 *
 * The versions come from folder names and from the node headers, so finding them executes nothing.
 * A shim (mise, Volta) is the one case where PATH hides the version: it is asked in a neutral folder,
 * the way the runtime row asks.
 *
 * Not known here: which versions other projects on the machine pin. A removal is a proposal for
 * the operator to weigh, and the one release line this project declares is left out of it. Node only;
 * PHP and Python keep their own row. Windows keeps its managers elsewhere and is not read.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SecurityCheckResult } from "./check-security.js";
import { assessFromLookup, serviceFor } from "./upstream-runtime-report.js";
import {
  detectRuntimes,
  readInstalledVersion,
  resolveBinary,
  RUNTIME_SPECS,
} from "./upstream-runtimes.js";
import type { RuntimeAssessment, RuntimeSpec } from "./upstream-runtimes.js";
import { lookupUpstream } from "./upstream-sources.js";
import type { UpstreamLookup, UpstreamService } from "./upstream-sources.js";

export type Manager = "mise" | "homebrew" | "nvm" | "fnm" | "volta" | "system";

export interface InstallEntry {
  manager: Manager;
  version: string;
  /** The folder the install lives in. Printed only after being cleaned. */
  dir: string;
}

export interface InstallRoots {
  home: string;
  env: Record<string, string | undefined>;
  /** Homebrew prefixes to look in, such as /opt/homebrew and /usr/local. */
  brewPrefixes: string[];
  /** Where a plain installer puts Node: /usr/local. */
  systemPrefix: string;
}

export interface Winner {
  manager: Manager | "other";
  version: string | null;
  shim: boolean;
}

const GATE_TTL_MS = 24 * 60 * 60 * 1000;
const FULL_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const BREW_VERSION = /^(\d+\.\d+\.\d+)(?:_\d+)?$/;
const BREW_FORMULA = /^node(?:@\d+)?$/;
const NAME = "runtime installs: node";
const MAX_LISTED = 6;
const base = { category: "supply-chain", name: NAME } as const;

/** Printable ASCII on one line: a folder or manager name must not forge a line of the report. */
function plain(value: unknown, max = 80): string {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max);
}

function triple(version: string): [number, number, number] | null {
  const m = FULL_VERSION.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: string, b: string): number {
  const x = triple(a);
  const y = triple(b);
  if (!x || !y) return 0;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const newer = (a: string, b: string) => compareVersions(a, b) > 0;

interface ManagerDirs {
  mise: string;
  nvm: string;
  fnm: string;
  volta: string;
}

function managerDirs(r: InstallRoots): ManagerDirs {
  const data = r.env.XDG_DATA_HOME || join(r.home, ".local", "share");
  return {
    mise: r.env.MISE_DATA_DIR || join(data, "mise"),
    nvm: r.env.NVM_DIR || join(r.home, ".nvm"),
    fnm: r.env.FNM_DIR || join(data, "fnm"),
    volta: r.env.VOLTA_HOME || join(r.home, ".volta"),
  };
}

/** The entries of a folder that are real folders (not links), or none when it cannot be read. */
function realSubfolders(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
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

function fromFolder(
  manager: Manager,
  dir: string,
  strip: (name: string) => string | null,
): InstallEntry[] {
  const out: InstallEntry[] = [];
  for (const name of realSubfolders(dir)) {
    const version = strip(name);
    if (version !== null && FULL_VERSION.test(version)) {
      out.push({ manager, version, dir: join(dir, name) });
    }
  }
  return out;
}

const dropV = (name: string) => (name.startsWith("v") ? name.slice(1) : null);
const exact = (name: string) => name;

function brewInstalls(prefixes: string[]): InstallEntry[] {
  const out: InstallEntry[] = [];
  for (const prefix of new Set(prefixes)) {
    const cellar = join(prefix, "Cellar");
    for (const formula of realSubfolders(cellar).filter((f) => BREW_FORMULA.test(f))) {
      out.push(
        ...fromFolder("homebrew", join(cellar, formula), (n) => BREW_VERSION.exec(n)?.[1] ?? null),
      );
    }
  }
  return out;
}

/** Node installed by a plain installer: the version is in the headers, which are read, not run. */
function systemInstall(prefix: string): InstallEntry[] {
  const bin = join(prefix, "bin", "node");
  const header = join(prefix, "include", "node", "node_version.h");
  try {
    if (!existsSync(bin) || lstatSync(bin).isSymbolicLink()) return [];
    const text = readFileSync(header, "utf8");
    const part = (name: string) =>
      new RegExp(`#define NODE_${name}_VERSION (\\d+)`).exec(text)?.[1];
    const [major, minor, patch] = [part("MAJOR"), part("MINOR"), part("PATCH")];
    if (major === undefined || minor === undefined || patch === undefined) return [];
    return [{ manager: "system", version: `${major}.${minor}.${patch}`, dir: prefix }];
  } catch {
    return [];
  }
}

/** Every Node install the managers and Homebrew keep, newest first. Executes nothing. */
export function inventoryNodeInstalls(roots: InstallRoots): InstallEntry[] {
  const d = managerDirs(roots);
  const all = [
    ...fromFolder("mise", join(d.mise, "installs", "node"), exact),
    ...fromFolder("nvm", join(d.nvm, "versions", "node"), dropV),
    ...fromFolder("fnm", join(d.fnm, "node-versions"), dropV),
    ...fromFolder("volta", join(d.volta, "tools", "image", "node"), exact),
    ...brewInstalls(roots.brewPrefixes),
    ...systemInstall(roots.systemPrefix),
  ];
  return all.sort((a, b) => compareVersions(b.version, a.version));
}

/** Both sides with forward slashes, so the comparison does not depend on the platform's separator. */
const posix = (path: string) => path.split("\\").join("/");
const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function versionAfter(
  path: string,
  dir: string,
  strip: (name: string) => string | null,
): string | null {
  const first = path.slice(dir.length + 1).split("/")[0] ?? "";
  const version = strip(first);
  return version !== null && FULL_VERSION.test(version) ? version : null;
}

/** Which manager a binary belongs to, from where it lives. A shim is named, not resolved. */
export function classifyBinary(rawPath: string, roots: InstallRoots): Winner {
  const path = posix(rawPath);
  const raw = managerDirs(roots);
  const d = {
    mise: posix(raw.mise),
    nvm: posix(raw.nvm),
    fnm: posix(raw.fnm),
    volta: posix(raw.volta),
  };
  if (inside(path, `${d.mise}/shims`)) return { manager: "mise", version: null, shim: true };
  if (inside(path, `${d.volta}/bin`)) return { manager: "volta", version: null, shim: true };
  const rules: [Manager, string, (n: string) => string | null][] = [
    ["mise", `${d.mise}/installs/node`, exact],
    ["nvm", `${d.nvm}/versions/node`, dropV],
    ["fnm", `${d.fnm}/node-versions`, dropV],
    ["volta", `${d.volta}/tools/image/node`, exact],
  ];
  for (const [manager, dir, strip] of rules) {
    if (inside(path, dir)) return { manager, version: versionAfter(path, dir, strip), shim: false };
  }
  for (const prefix of roots.brewPrefixes) {
    const cellar = `${posix(prefix)}/Cellar`;
    if (!inside(path, cellar)) continue;
    const rest = path.slice(cellar.length + 1).split("/");
    const version = BREW_VERSION.exec(rest[1] ?? "")?.[1] ?? null;
    return { manager: "homebrew", version, shim: false };
  }
  return { manager: "other", version: null, shim: false };
}

export interface InstallFacts {
  installs: InstallEntry[];
  winner: Winner | null;
  assess: (version: string) => RuntimeAssessment;
  /** The release line this project declares, when it declares one. */
  projectMajor: number | null;
}

const BAD = new Set<RuntimeAssessment["verdict"]>(["end of life", "security release available"]);

function describeBad(verdict: RuntimeAssessment["verdict"]): string {
  return verdict === "end of life" ? "end of life" : "lacks a security release";
}

function removal(e: InstallEntry): string {
  const v = plain(e.version, 20);
  switch (e.manager) {
    case "mise":
      return `mise uninstall node@${v}`;
    case "nvm":
      return `nvm uninstall ${v}`;
    case "fnm":
      return `fnm uninstall ${v}`;
    case "homebrew": {
      const formula = basename(dirname(e.dir));
      return `brew uninstall ${BREW_FORMULA.test(formula) ? formula : "node"}`;
    }
    case "volta":
      return `${v} (volta): volta has no command to remove a Node version, delete its folder under the Volta home`;
    default:
      return `${v} is installed outside a version manager: remove it the way you installed it`;
  }
}

function unverified(why: string): SecurityCheckResult {
  return {
    ...base,
    status: "warn",
    severity: "medium",
    detail: `unverified: ${plain(why, 160)}`,
    suggestion: "kit upstream check  (fills the release cache), or kit check --online",
  };
}

function unusedBad(f: InstallFacts): InstallEntry[] {
  const winnerVersion = f.winner?.version ?? null;
  return f.installs.filter((e) => {
    if (e.version === winnerVersion) return false;
    if (f.projectMajor !== null && triple(e.version)?.[0] === f.projectMajor) return false;
    return BAD.has(f.assess(e.version).verdict);
  });
}

function listing(entries: InstallEntry[]): string {
  const shown = entries.slice(0, MAX_LISTED).map((e) => `${plain(e.version, 20)} (${e.manager})`);
  const more = entries.length > MAX_LISTED ? `, and ${entries.length - MAX_LISTED} more` : "";
  return `${shown.join(", ")}${more}`;
}

function winnerFailure(f: InstallFacts, winner: Winner, verdict: RuntimeAssessment["verdict"]) {
  const v = plain(winner.version ?? "?", 20);
  const lower = f.installs.filter(
    (e) =>
      winner.version !== null &&
      newer(e.version, winner.version) &&
      !BAD.has(f.assess(e.version).verdict),
  );
  const hint = lower[0]
    ? `. ${plain(lower[0].version, 20)} (${lower[0].manager}) is installed but comes later in PATH`
    : "";
  const own = f.installs.find((e) => e.version === winner.version);
  return {
    ...base,
    status: "fail" as const,
    severity: "high" as const,
    hasFindings: true as const,
    detail: `PATH runs Node ${v} (${winner.manager}): ${describeBad(verdict)}${hint}`,
    suggestion: [own ? removal(own) : undefined, "or put a supported install first in PATH"]
      .filter(Boolean)
      .join("; "),
  };
}

/** The verdict for one machine. Pure. */
export function judgeInstalls(f: InstallFacts): SecurityCheckResult {
  const { installs, winner } = f;
  if (installs.length === 0 && !winner) {
    return {
      ...base,
      status: "skip",
      detail: "no Node install found in a version manager, Homebrew or /usr/local",
    };
  }
  if (!winner) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      detail: `Node is installed (${listing(installs)}) but none is on PATH`,
    };
  }
  if (winner.version === null) {
    return unverified(
      winner.shim
        ? `the Node on PATH is a ${winner.manager} shim and its version could not be read`
        : "the version of the Node on PATH could not be read",
    );
  }
  const verdict = f.assess(winner.version).verdict;
  if (BAD.has(verdict)) return winnerFailure(f, winner, verdict);
  if (verdict === "unknown") return unverified("no release data for the Node on PATH");
  const unused = unusedBad(f);
  if (unused.length > 0) {
    const n = unused.length;
    return {
      ...base,
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `${n} unused install${n === 1 ? " is" : "s are"} end of life or lack a security release: ${listing(unused)}`,
      suggestion: unused.slice(0, MAX_LISTED).map(removal).join("; "),
    };
  }
  const count = installs.length;
  return {
    ...base,
    status: "pass",
    detail: `PATH runs Node ${plain(winner.version, 20)} (${winner.manager}); ${count} install${count === 1 ? "" : "s"}, none end of life or lacking a security release`,
  };
}

export interface InstallDeps {
  platform: string;
  roots: InstallRoots;
  inventory: (roots: InstallRoots) => InstallEntry[];
  winnerPath: (root: string) => string | null;
  realpath: (path: string) => string;
  detectNode: (root: string) => { declared: string | null } | null;
  readInstalled: (spec: RuntimeSpec, root: string) => Promise<string | null>;
  lookup: (
    service: UpstreamService,
    opts: { cacheOnly: boolean; ttlMs: number },
  ) => Promise<UpstreamLookup>;
  /** Replaces the lookup-based assessment. For tests. */
  assess?: (version: string) => RuntimeAssessment;
  online: boolean;
}

function defaultDeps(online: boolean | undefined): InstallDeps {
  const env = process.env;
  const prefixes = [
    "/opt/homebrew",
    "/usr/local",
    ...(env.HOMEBREW_PREFIX ? [env.HOMEBREW_PREFIX] : []),
  ];
  return {
    platform: process.platform,
    roots: { home: env.HOME ?? "", env, brewPrefixes: prefixes, systemPrefix: "/usr/local" },
    inventory: inventoryNodeInstalls,
    winnerPath: (root) => resolveBinary("node", env.PATH, root),
    realpath: (p) => {
      try {
        return realpathSync.native(p);
      } catch {
        return p;
      }
    },
    detectNode: (root) => detectRuntimes(root).find((r) => r.id === "node") ?? null,
    readInstalled: readInstalledVersion,
    lookup: (service, opts) => lookupUpstream(service, opts),
    online: online === true,
  };
}

function majorOf(declared: string | null): number | null {
  const m = /^v?(\d+)/.exec(declared ?? "");
  return m ? Number(m[1]) : null;
}

async function winnerOf(root: string, d: InstallDeps, spec: RuntimeSpec): Promise<Winner | null> {
  const path = d.winnerPath(root);
  if (path === null) return null;
  const named = classifyBinary(path, d.roots);
  const resolved = named.shim ? named : classifyBinary(d.realpath(path), d.roots);
  if (resolved.version !== null) return resolved;
  // A shim, or a binary outside every manager: ask it, in a neutral folder.
  return { ...resolved, version: await d.readInstalled(spec, root) };
}

/** The installs row for a project that uses Node. Nothing for one that does not. */
export async function checkRuntimeInstalls(
  root: string,
  deps?: Partial<InstallDeps> & { online?: boolean },
): Promise<SecurityCheckResult[]> {
  const d: InstallDeps = { ...defaultDeps(deps?.online), ...deps };
  const detected = d.detectNode(root);
  if (detected === null) return [];
  if (d.platform === "win32") {
    return [
      {
        ...base,
        status: "skip",
        detail:
          "the version managers keep their installs elsewhere on Windows, which is not read yet",
      },
    ];
  }
  const spec = RUNTIME_SPECS.find((s) => s.id === "node") as RuntimeSpec;
  let assess = d.assess;
  if (!assess) {
    const found = await d.lookup(serviceFor(spec), { cacheOnly: !d.online, ttlMs: GATE_TTL_MS });
    assess = (v) => assessFromLookup(spec, v, found, Date.now());
  }
  return [
    judgeInstalls({
      installs: d.inventory(d.roots),
      winner: await winnerOf(root, d, spec),
      assess,
      projectMajor: majorOf(detected.declared),
    }),
  ];
}
