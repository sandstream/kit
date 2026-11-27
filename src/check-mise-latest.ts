/**
 * The mise fork loop: an `npm:` tool pinned to `latest` in a mise config while `npm` on PATH is
 * mise's own shim.
 *
 * To resolve `latest` for an `npm:` tool, mise (v2026.6.11, `src/backend/npm.rs`) runs
 * `npm view <pkg> dist-tags --json` with the first `npm` on PATH. When that `npm` is mise's shim,
 * the shim resolves the toolset again, which runs `npm view` again, without bound. Every `npm`
 * command, and every `mise` command that resolves the toolset, can start it. One machine had 4,425
 * orphaned `npm view` processes in under a minute and needed a reboot. Older kit releases wrote
 * such entries (`mise use npm:x@latest`, without `--path`, from the home folder).
 *
 * The `pipx:` backend is not covered: mise reads PyPI over HTTP for it (`src/backend/pipx.rs`),
 * so a `pipx:` tool at `latest` starts no subprocess and cannot loop.
 *
 * The row reads files only. It never runs mise or npm, because either could start the loop.
 * `kit fix` (`pinMiseLatest`) pins each entry to the version installed under mise's data folder.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parse } from "smol-toml";
import type { SecurityCheckResult } from "./check-security.js";
import type { HitlBlock } from "./hitl.js";
import { c } from "./utils/colors.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";

/** Where the check looks. Injected so tests use a temp folder and never the real machine. */
export interface MiseLatestEnv {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

const defaultEnv = (): MiseLatestEnv => ({
  env: process.env,
  home: homedir(),
  platform: process.platform,
});

const NAME = "mise npm: tools at latest";

/** mise's global config file, as mise finds it (MISE_GLOBAL_CONFIG_FILE, MISE_CONFIG_DIR, XDG). */
export function globalMiseConfig(env: NodeJS.ProcessEnv, home: string): string {
  const file = env.MISE_GLOBAL_CONFIG_FILE?.trim();
  if (file) return file;
  const dir =
    env.MISE_CONFIG_DIR?.trim() ||
    join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "mise");
  return join(dir, "config.toml");
}

/** mise's data folder (installs, shims). */
function miseDataDir(e: MiseLatestEnv): string {
  const set = e.env.MISE_DATA_DIR?.trim();
  if (set) return set;
  if (e.platform === "win32") return join(e.env.LOCALAPPDATA?.trim() || e.home, "mise");
  return join(e.env.XDG_DATA_HOME?.trim() || join(e.home, ".local", "share"), "mise");
}

/** The mise configs in scope: the project's `mise.toml` and `.mise.toml`, and the global one. */
function configFiles(cwd: string, e: MiseLatestEnv): string[] {
  const files = [join(cwd, "mise.toml"), join(cwd, ".mise.toml"), globalMiseConfig(e.env, e.home)];
  return files.filter((f, i) => files.indexOf(f) === i && isFile(f));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pinnedToLatest(value: unknown): boolean {
  if (value === "latest") return true;
  if (Array.isArray(value)) return value.some(pinnedToLatest);
  if (value && typeof value === "object")
    return (value as { version?: unknown }).version === "latest";
  return false;
}

/** The `npm:` tools a mise config pins to `latest`. An unparsable file yields none. */
export function latestNpmTools(toml: string): string[] {
  let tools: unknown;
  try {
    tools = (parse(toml) as { tools?: unknown }).tools;
  } catch {
    return [];
  }
  if (!tools || typeof tools !== "object") return [];
  return Object.entries(tools as Record<string, unknown>)
    .filter(([name, value]) => /^npm:/i.test(name) && pinnedToLatest(value))
    .map(([name]) => name);
}

/**
 * mise's `npm` shim, when it exists and mise's shims folder is on PATH; otherwise null.
 *
 * Not "the first `npm` on PATH": kit usually runs under a node that mise started, and mise puts
 * that node's own bin folder (with a real `npm`) ahead of everything for the child process. Kit's
 * PATH then hides the shim that the user's shell, and mise's own `npm view`, find first. Measured:
 * the shell resolved `npm` to the shim while `node -e` saw the real npm first. So the check asks
 * whether the shim exists and its folder is on PATH at all.
 */
function miseNpmShim(e: MiseLatestEnv): string | null {
  const shims = join(miseDataDir(e), "shims");
  const shimsId = identityOf(shims);
  const onPath = (e.env.PATH ?? e.env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => sameIdentity(identityOf(dir), shimsId));
  if (!onPath) return null;
  const names = e.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  for (const name of names) {
    const path = join(shims, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The folder name mise installs a tool under: `npm:@scope/pkg` → `npm-scope-pkg`. */
function installFolder(tool: string): string {
  return tool.replace(/@/g, "").replace(/[:/\\]/g, "-");
}

function semverParts(v: string): number[] {
  return v.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
}

/** The newest version installed under mise's data folder, skipping mise's alias links. */
export function installedMiseVersion(dataDir: string, tool: string): string | null {
  const dir = join(dataDir, "installs", installFolder(tool));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const real = entries.filter((v) => {
    if (!/^\d+\.\d+\.\d+$/.test(v)) return false;
    try {
      const info = lstatSync(join(dir, v));
      return info.isDirectory() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  });
  real.sort((a, b) => {
    const [x, y] = [semverParts(a), semverParts(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  return real[0] ?? null;
}

function shown(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

interface Hit {
  file: string;
  tool: string;
}

function hits(cwd: string, e: MiseLatestEnv): Hit[] {
  return configFiles(cwd, e).flatMap((file) => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    return latestNpmTools(text).map((tool) => ({ file, tool }));
  });
}

/** The `kit check` row (security dimension, category supply-chain). Reads files only. */
export function checkMiseLatest(
  cwd: string,
  e: MiseLatestEnv = defaultEnv(),
): SecurityCheckResult[] {
  const base = { category: "supply-chain", name: NAME } as const;
  const found = hits(cwd, e);
  if (found.length === 0) {
    return [
      { ...base, status: "pass", detail: "no mise config in scope pins an npm: tool to latest" },
    ];
  }
  const list = found.map((h) => `${h.tool} in ${shown(h.file, e.home)}`).join(", ");
  const shim = miseNpmShim(e);
  if (!shim) {
    return [
      {
        ...base,
        status: "pass",
        detail: `${list} at latest, but mise has no npm shim on PATH here, so mise cannot loop on it`,
      },
    ];
  }
  const data = miseDataDir(e);
  const pins = found.map((h) => {
    const v = installedMiseVersion(data, h.tool);
    return v ? `${h.tool} → ${v}` : `${h.tool} (not installed: pin an exact version by hand)`;
  });
  return [
    {
      ...base,
      status: "warn",
      severity: "high",
      detail:
        `${list} at "latest" while mise's npm shim (${shown(shim, e.home)}) is on PATH. ` +
        "To resolve latest, mise runs `npm view <pkg> dist-tags --json` through that shim, which " +
        "resolves the toolset again: a fork loop that can start thousands of processes when the " +
        "network is slow.",
      suggestion: `Run \`kit fix\` to pin each to its installed version (${pins.join(", ")}).`,
    },
  ];
}

export type PinOutcome =
  { file: string; tool: string; to: string } | { file: string; tool: string; reason: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pin each `npm:` tool at `latest` to its installed version, in place. Only the plain string form
 * (`"npm:x" = "latest"`) is rewritten; a table or list form is reported for a hand edit. Comments
 * and every other line stay as they are. Refused in read-only mode.
 */
export async function pinMiseLatest(
  cwd: string,
  e: MiseLatestEnv = defaultEnv(),
): Promise<PinOutcome[]> {
  const found = hits(cwd, e);
  if (found.length === 0) return [];
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("mise-pin-latest", { tools: found.map((h) => h.tool) });
    return [
      { file: found[0].file, tool: found.map((h) => h.tool).join(", "), reason: refusal.reason },
    ];
  }
  const data = miseDataDir(e);
  const out: PinOutcome[] = [];
  const byFile = new Map<string, string[]>();
  for (const h of found) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.tool]);
  for (const [file, tools] of byFile) {
    let text = readFileSync(file, "utf8");
    let changed = false;
    for (const tool of tools) {
      const version = installedMiseVersion(data, tool);
      if (!version) {
        out.push({
          file,
          tool,
          reason: `${tool} is not installed; set an exact version in ${shown(file, e.home)}`,
        });
        continue;
      }
      const line = new RegExp(`^(\\s*(["'])${escapeRe(tool)}\\2\\s*=\\s*)(["'])latest\\3`, "m");
      if (!line.test(text)) {
        out.push({
          file,
          tool,
          reason: `${tool} is not a plain "latest" string; set ${version} in ${shown(file, e.home)} by hand`,
        });
        continue;
      }
      text = text.replace(
        line,
        (_m, head: string, _q: string, q: string) => `${head}${q}${version}${q}`,
      );
      changed = true;
      out.push({ file, tool, to: version });
    }
    if (changed) writeFileSync(file, text);
  }
  return out;
}

/** What `kit fix` prints and records for the fork loop: nothing unless the row warns. */
export async function migrateMiseLatest(
  cwd: string,
  e: MiseLatestEnv = defaultEnv(),
): Promise<{ lines: string[]; fixed: number; manual: Omit<HitlBlock, "owner">[] }> {
  const out = { lines: [] as string[], fixed: 0, manual: [] as Omit<HitlBlock, "owner">[] };
  if (checkMiseLatest(cwd, e)[0]?.status !== "warn") return out;
  for (const o of await pinMiseLatest(cwd, e)) {
    if ("to" in o) {
      out.fixed++;
      out.lines.push(`  ${c.green}✓${c.reset} ${o.tool}  pinned  latest → ${o.to} in ${o.file}`);
      continue;
    }
    out.lines.push(`  ${c.red}✗${c.reset} ${o.tool}  ${o.reason}`);
    out.manual.push({
      blocker: `${o.tool} is pinned to latest in a mise config while mise's npm shim is on PATH`,
      reason: "mise resolves npm: latest by running npm view through its own shim, which loops",
      steps: [o.reason, "Run `kit check --category security`."],
      respondWith: `${o.tool} pinned to an exact version`,
      agentContinuesWith: "kit check --category security",
    });
  }
  return out;
}
