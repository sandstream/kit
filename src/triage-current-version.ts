/**
 * The version installed now, for the cooling waiver (Z6). The waiver lets a fresh release through
 * only when OSV says it is the first one that fixes an advisory for the version in use, so kit has
 * to know that version. It read only the project lockfile, so a global install (`npm i -g`, kit's
 * own `kit upgrade --self` among them), a `node_modules` with no lockfile and every pip triage said
 * "no current version known" and a security patch waited out the full cooling period.
 *
 * The order of trust:
 *   1. the project lockfile (npm) or Gemfile.lock (gem): what the project pins;
 *   2. npm's global install: `<prefix>/lib/node_modules/<pkg>` (POSIX) or `<prefix>\node_modules\<pkg>`
 *      (Windows), the prefix taken from npm's own settings without running npm;
 *   3. the project's `node_modules/<pkg>`;
 *   pip: the `.dist-info/METADATA` in the site-packages of the `python3` kit runs triage.py with;
 *   gem: the gemspec file names under GEM_HOME and GEM_PATH.
 *
 * Trust no one: an installed copy is a file anyone could have written. A version read from one counts
 * only when the registry kit already fetched has published it, and it is used for the waiver only.
 * It never skips the cooling period the way a lockfile pin of the same version does (`installed`).
 * The first source that has the package decides; one that names an unpublished version makes the
 * version unknown instead of falling through to the next.
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";

/** Where installed copies live on this machine. Injected, so both platform layouts test on one OS. */
export interface InstallLocator {
  platform: NodeJS.Platform;
  /** The node binary kit runs on: its prefix is npm's default global prefix. */
  execPath: string;
  home: string;
  /** Site-packages folders of the `python3` kit runs, in import order; [] when unknown. */
  sitePackages: (cwd: string) => Promise<string[]>;
}

/** The current version and where it came from, or a note naming every source checked. */
export interface CurrentVersion {
  version?: string;
  /** Where the version came from, as printed: "the global install". */
  from?: string;
  /** True when it came from an installed copy, not a lockfile: it may only feed the waiver. */
  installed?: boolean;
  /** Why no version is known, naming the sources checked. */
  note?: string;
}

interface Probe {
  /** What the cooling line calls the source. */
  label: string;
  /** The same, with where it looked, for the list of sources checked. */
  checked: string;
  read: () => string | undefined | Promise<string | undefined>;
}

const SHOWN = /[^\x20-\x7e]/g;

function shown(value: string): string {
  return value.replace(SHOWN, "?").slice(0, 80);
}

async function safely(probe: Probe): Promise<string | undefined> {
  try {
    const v = await probe.read();
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined; // unreadable (a symlink, too large, not JSON): not a version
  }
}

/**
 * The first source in the order of trust that has the package. `locked` is the lockfile's pin,
 * already read; an installed source counts only when `published` lists its version.
 */
export async function resolveCurrent(
  locked: { label: string; version?: string },
  probes: Probe[],
  published: readonly string[],
): Promise<CurrentVersion> {
  if (locked.version) return { version: locked.version, from: locked.label };
  const checked = [locked.label];
  for (const probe of probes) {
    checked.push(probe.checked);
    const version = await safely(probe);
    if (version === undefined) continue;
    if (published.includes(version)) return { version, from: probe.label, installed: true };
    const why = `${probe.label} has ${shown(version)}, which the registry has never published`;
    return { note: `no current version known (${why}), so a security patch cannot be recognised` };
  }
  return {
    note: `no current version known (checked ${checked.join(", ")}), so a security patch cannot be recognised`,
  };
}

/** The `prefix` an npmrc sets, `~` expanded; null when it sets none, "" when it cannot be read as a path. */
function npmrcPrefix(text: string, home: string): string | null {
  const m = /^\s*prefix\s*=\s*(.*?)\s*$/m.exec(text);
  if (!m) return null;
  const value = m[1].replace(/^(["'])(.*)\1$/, "$2");
  if (value.includes("${")) return ""; // an environment reference npm would expand: not guessed
  return /^~[/\\]/.test(value) ? join(home, value.slice(2)) : value;
}

/**
 * npm's global prefix as npm itself would pick it, without running npm: the environment, then the
 * user npmrc, then the prefix of the node binary kit runs (`<prefix>/bin/node` on POSIX, nvm's
 * `~/.nvm/versions/node/vX` included; `<prefix>\node.exe` on Windows). Null when an npmrc names a
 * prefix kit cannot resolve.
 */
export function npmGlobalPrefix(env: NodeJS.ProcessEnv, loc: InstallLocator): string | null {
  const fromEnv = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || env.PREFIX;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    const rc = readRegularFileIfPresent(env.npm_config_userconfig || join(loc.home, ".npmrc"));
    const set = rc === null ? null : npmrcPrefix(rc, loc.home);
    if (set !== null) return set || null;
  } catch {
    /* an unreadable npmrc sets nothing kit can see */
  }
  return loc.platform === "win32" ? dirname(loc.execPath) : dirname(dirname(loc.execPath));
}

/** npm's global `node_modules`: `<prefix>/lib/node_modules` on POSIX, `<prefix>\node_modules` on Windows. */
export function npmGlobalRoot(env: NodeJS.ProcessEnv, loc: InstallLocator): string | null {
  const prefix = npmGlobalPrefix(env, loc);
  if (!prefix) return null;
  return loc.platform === "win32"
    ? join(prefix, "node_modules")
    : join(prefix, "lib", "node_modules");
}

/** The version a package's own package.json gives, when it names that package. */
function manifestVersion(root: string, pkg: string): string | undefined {
  const text = readRegularFileIfPresent(join(root, ...pkg.split("/"), "package.json"));
  if (text === null) return undefined;
  const m = JSON.parse(text) as { name?: unknown; version?: unknown };
  return m.name === pkg && typeof m.version === "string" ? m.version : undefined;
}

/** The npm sources after the lockfile: the global install, then the project's node_modules. */
export function npmProbes(
  cwd: string,
  pkg: string,
  env: NodeJS.ProcessEnv,
  loc: InstallLocator,
): Probe[] {
  const root = npmGlobalRoot(env, loc);
  return [
    {
      label: "the global install",
      checked: root
        ? `the global install (${root})`
        : "the global install (npm's prefix unresolved)",
      read: () => (root ? manifestVersion(root, pkg) : undefined),
    },
    {
      label: "node_modules",
      checked: "node_modules",
      read: () => manifestVersion(join(cwd, "node_modules"), pkg),
    },
  ];
}

/** A distribution name normalised per PEP 503. */
export function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The `Name` and `Version` headers of a METADATA file (an email-style header block). */
function metadataHeaders(text: string): { name?: string; version?: string } {
  const head = text.split(/\r?\n\r?\n/, 1)[0];
  return {
    name: /^Name:\s*(.+?)\s*$/m.exec(head)?.[1],
    version: /^Version:\s*(.+?)\s*$/m.exec(head)?.[1],
  };
}

/** The installed version of a distribution: the first `<name>-<version>.dist-info` in import order. */
export function distInfoVersion(dirs: readonly string[], name: string): string | undefined {
  const want = pep503(name);
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dist-info")) continue;
      // `<name>-<version>`; the Name header below decides, so a longer name with this prefix is harmless.
      if (!pep503(entry.slice(0, -".dist-info".length)).startsWith(`${want}-`)) continue;
      const text = readRegularFileIfPresent(join(dir, entry, "METADATA"));
      const meta = text === null ? {} : metadataHeaders(text);
      if (meta.name && pep503(meta.name) === want && meta.version) return meta.version;
    }
  }
  return undefined;
}

/** The pip source: the installed metadata of the interpreter kit runs. */
export function pipProbes(cwd: string, name: string, loc: InstallLocator): Probe[] {
  return [
    {
      label: "the installed dist-info",
      checked: "the dist-info in python3's site-packages",
      read: async () => distInfoVersion(await loc.sitePackages(cwd), name),
    },
  ];
}

function numeric(version: string): number[] {
  return version.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
}

function newer(a: string, b: string): boolean {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The newest installed gem version that the registry has published, from the gemspec file names
 * (`<name>-<version>[-<platform>].gemspec`) under `<dir>/specifications`. A gemspec is Ruby code:
 * only its name is read. A version the registry never published is returned when it is the only
 * one, so the caller can say so.
 */
export function installedGemVersion(
  dirs: readonly string[],
  name: string,
  published: readonly string[],
): string | undefined {
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(join(dir, "specifications"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${name}-`) || !entry.endsWith(".gemspec")) continue;
      const rest = entry.slice(name.length + 1, -".gemspec".length);
      const v = /^([0-9][0-9A-Za-z.]*)(?:-.+)?$/.exec(rest)?.[1];
      if (v) found.push(v);
    }
  }
  const real = found.filter((v) => published.includes(v));
  const pool = real.length > 0 ? real : found;
  return pool.reduce<string | undefined>(
    (best, v) => (!best || newer(v, best) ? v : best),
    undefined,
  );
}

/** The gem source after Gemfile.lock: GEM_HOME and GEM_PATH, read without running Ruby. */
export function gemProbes(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  published: readonly string[],
): Probe[] {
  const sep = platform === "win32" ? ";" : ":";
  const dirs = [env.GEM_HOME, ...(env.GEM_PATH ?? "").split(sep)].filter(
    (d): d is string => typeof d === "string" && d.trim().length > 0,
  );
  return [
    {
      label: "the installed gems",
      checked: dirs.length
        ? "the installed gems (GEM_HOME, GEM_PATH)"
        : "the installed gems (GEM_HOME and GEM_PATH are not set; Ruby's default is not guessed)",
      read: () => installedGemVersion(dirs, name, published),
    },
  ];
}

const SITE_PACKAGES =
  "import json,site,sysconfig;p=[sysconfig.get_paths()[k] for k in ('purelib','platlib')];" +
  "p+=getattr(site,'getsitepackages',lambda:[])();p.append(site.getusersitepackages());" +
  "print(json.dumps(p))";

/**
 * The site-packages of `python3`, the interpreter kit already runs triage.py with. `-I` keeps the
 * project's folder and PYTHON* variables out of its import path, so nothing in `cwd` runs.
 */
async function pythonSitePackages(cwd: string): Promise<string[]> {
  try {
    const { exec } = await import("./utils/exec.js");
    const { stdout } = await exec("python3", ["-I", "-c", SITE_PACKAGES], {
      cwd,
      timeout: 15_000,
      encoding: "utf8",
    });
    const list = JSON.parse(stdout) as unknown;
    return Array.isArray(list)
      ? [...new Set(list.filter((p): p is string => typeof p === "string"))]
      : [];
  } catch {
    return [];
  }
}

export const defaultInstallLocator: InstallLocator = {
  platform: process.platform,
  execPath: process.execPath,
  home: homedir(),
  sitePackages: pythonSitePackages,
};
