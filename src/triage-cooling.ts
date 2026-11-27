/**
 * The cooling period (Z6). A release younger than the limit is a supply-chain risk, because a
 * compromised release is usually caught within days. `kit triage npm` and `kit triage pip` hold one back
 * (or only warn, with `min_release_age_enforce = false`), and say which version has been public long enough.
 *
 * A security patch must not wait. The warning is waived only when the advisory source (OSV) says the
 * candidate is the FIRST published release that fixes an advisory for the version the lockfile pins
 * now. Two narrower rules keep the waiver from becoming a way round the cooling period:
 *
 *   - It comes from OSV and nothing else. A release that calls itself a security fix is not one.
 *   - A newer release than the first fixed one is not waived. An old advisory about the version in
 *     use must not let a brand new release through under its cover.
 *
 * The version in use comes from the project lockfile first, then from an installed copy (npm's global
 * install, `node_modules`, pip's dist-info), which counts only when the registry has published it
 * (`triage-current-version.ts`). The cooling line says which source it was.
 *
 * With no current version, with OSV unreachable, or with air-gap on and no OSV mirror named, the
 * warning stays and says why. This runs after triage.py: the bundled script is a frozen, verified
 * asset and reads no project files. The summary counts and the score take the cooling line, with
 * triage.py's own penalties (`countCoolingWarnings`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveInstalledVersion } from "./upstream-installed.js";
import { readRegularFileIfPresent } from "./upstream-safe-read.js";
import { pipName, pypiJsonUrl, pypiReleaseTimes } from "./triage-cooling-pypi.js";
import {
  defaultInstallLocator,
  npmProbes,
  pipProbes,
  resolveCurrent,
  type CurrentVersion,
  type InstallLocator,
} from "./triage-current-version.js";

export interface SupplyChainConfig {
  internal_scopes?: string[];
  /** Days a release must have been public before triage stops warning. Default 14, 0 turns it off. */
  min_release_age_days?: number;
  /**
   * A release inside the cooling period holds back the pass instead of only warning. Default true;
   * false turns the hold into a warning.
   */
  min_release_age_enforce?: boolean;
}

const DEFAULT_COOLING_DAYS = 14;
const DAY_MS = 86_400_000;
const NPM_NAME = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const LOCKFILES = new Set(["package-lock.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** A vulnerability record as far as the waiver reads it. */
export interface OsvVuln {
  id: string;
  affected?: {
    package?: { name?: string };
    ranges?: { type?: string; events?: Record<string, string>[] }[];
  }[];
}

/** OSV records for one version, or null when OSV could not be asked or answered. */
export type OsvLookup = (pkg: string, version: string) => Promise<OsvVuln[] | null>;

/** The package name of an npm target such as `express`, `express@4` or `@scope/pkg@^1`, or null. */
export function npmName(target: string): string | null {
  const at = target.lastIndexOf("@");
  const name = at > 0 ? target.slice(0, at) : target;
  return NPM_NAME.test(name) ? name : null;
}

/** The range package.json declares for the package, or "" when it names none. A yarn.lock needs it. */
function declaredRange(cwd: string, name: string): string {
  try {
    const text = readRegularFileIfPresent(join(cwd, "package.json"));
    const manifest = text === null ? {} : (JSON.parse(text) as Record<string, unknown>);
    for (const field of DEPENDENCY_FIELDS) {
      const range = (manifest[field] as Record<string, unknown> | undefined)?.[name];
      if (typeof range === "string") return range;
    }
  } catch {
    /* an unreadable manifest names no range */
  }
  return "";
}

/** The version a lockfile pins for the package, or undefined when none does. */
export function lockedVersion(cwd: string, target: string): string | undefined {
  const name = npmName(target);
  if (!name) return undefined;
  const found = resolveInstalledVersion(cwd, "package.json", name, declaredRange(cwd, name));
  return found.version && LOCKFILES.has(found.source) ? found.version : undefined;
}

type Triple = [number, number, number];

function triple(version: string): Triple | null {
  const m = STABLE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** A registry- or advisory-supplied string made safe to print on one line (it could carry a newline). */
function plain(value: unknown): string {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 80);
}

/** The smallest fixed version above `current` among the events of one range that covers `current`. */
function fixedInRange(events: Record<string, string>[], current: Triple): Triple | null {
  let best: Triple | null = null;
  let introduced: Triple = [0, 0, 0];
  for (const event of events) {
    if (event.introduced !== undefined) introduced = triple(event.introduced) ?? [0, 0, 0];
    const fixed = event.fixed === undefined ? null : triple(event.fixed);
    const applies =
      fixed !== null && compare(introduced, current) <= 0 && compare(fixed, current) > 0;
    if (fixed && applies && (!best || compare(fixed, best) < 0)) best = fixed;
  }
  return best;
}

function earlier(a: Triple | null, b: Triple | null): Triple | null {
  if (!a || !b) return a ?? b;
  return compare(a, b) <= 0 ? a : b;
}

/** The smallest fixed version above `current` in any SEMVER range of the advisory for this package. */
function firstFixed(vuln: OsvVuln, pkg: string, current: Triple): Triple | null {
  let best: Triple | null = null;
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== pkg) continue;
    for (const range of affected.ranges ?? []) {
      if (range.type === "SEMVER") best = earlier(best, fixedInRange(range.events ?? [], current));
    }
  }
  return best;
}

/** The lowest published stable version at or above `floor`. */
function lowestPublishedFrom(versions: string[], floor: Triple): string | null {
  let best: { v: string; t: Triple } | null = null;
  for (const v of versions) {
    const t = triple(v);
    if (t && compare(t, floor) >= 0 && (!best || compare(t, best.t) < 0)) best = { v, t };
  }
  return best?.v ?? null;
}

function ageDays(iso: string | undefined, now: number): number | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.floor((now - at) / DAY_MS);
}

/** The newest stable version that has been public for at least `limit` days. */
function newestOlder(
  versions: string[],
  times: Record<string, string>,
  limit: number,
  now: number,
) {
  let best: { v: string; age: number } | null = null;
  for (const v of versions) {
    const age = ageDays(times[v], now);
    if (!triple(v) || age === undefined || age < limit) continue;
    if (!best || age < best.age) best = { v, age };
  }
  return best?.v;
}

export interface CoolingInput {
  pkg: string;
  /** The version triage looked at: the one npm would install. */
  version: string;
  versions: string[];
  times: Record<string, string>;
  limitDays: number;
  enforce: boolean;
  /** The version in use now: the lockfile's pin, or a published version an installed copy has. */
  current?: string;
  /** Where `current` came from, printed on the cooling line ("the project lockfile"). */
  currentFrom?: string;
  /**
   * True when `current` came from an installed copy, not a lockfile. Such a version only feeds the
   * waiver: it never skips the cooling period the way a pin of the same version does.
   */
  currentInstalled?: boolean;
  /** Why no current version is known, naming the sources checked. */
  currentNote?: string;
  now: number;
  /** A lookup, or the reason advisories must not be queried (air-gap). */
  osv: OsvLookup | { skipped: string };
  /** How the suggested older version is spelled: npm's `pkg@1.2.3` (default) or pip's `pkg==1.2.3`. */
  pin?: "@" | "==";
}

/** What could not be established. Under enforcement doubt holds the pass back, as an unverified check must. */
export function unverified(why: string, enforce: boolean): CoolingResult {
  const line = enforce ? `  x CRITICAL: cooling: ${why}` : `  ~ NOT CHECKED: cooling -- ${why}`;
  return { lines: [line], held: enforce };
}

export interface CoolingResult {
  /** Lines in triage.py's own format, for the report. */
  lines: string[];
  /** True when the cooling period holds back the pass. */
  held: boolean;
}

type Waiver = { waived: string } | { note?: string };

async function waiver(input: CoolingInput): Promise<Waiver> {
  const { pkg, version, current, osv } = input;
  if (!current)
    return {
      note:
        input.currentNote ?? "no current version known, so a security patch cannot be recognised",
    };
  if (typeof osv !== "function") return { note: `advisories not queried: ${osv.skipped}` };
  const [before, after] = [await osv(pkg, current), await osv(pkg, version)];
  if (!before || !after) return { note: "advisories could not be checked" };
  const gone = before.filter((v) => !after.some((a) => a.id === v.id));
  const currentTriple = triple(current);
  if (gone.length === 0 || !currentTriple) return {};
  for (const vuln of gone) {
    const fixed = firstFixed(vuln, pkg, currentTriple);
    if (!fixed) return { note: `${plain(vuln.id)} names no fixed version` };
    const first = lowestPublishedFrom(input.versions, fixed);
    if (first !== version) {
      return {
        note: `the first release that fixes ${plain(vuln.id)} is ${plain(pkg)}@${plain(first)}`,
      };
    }
  }
  return { waived: gone.map((v) => plain(v.id)).join(", ") };
}

/** The cooling verdict for one release. Pure but for the injected advisory lookup. */
export async function coolingCheck(input: CoolingInput): Promise<CoolingResult> {
  const { version, limitDays, now } = input;
  const pinned = input.current === version && !input.currentInstalled;
  if (limitDays <= 0 || pinned) return { lines: [], held: false };
  const age = ageDays(input.times[version], now);
  if (age === undefined) {
    return unverified(`the registry gives no publish time for ${plain(version)}`, input.enforce);
  }
  if (age >= limitDays) return { lines: [], held: false };
  const result = await waiver(input);
  const source =
    input.current && input.currentFrom
      ? `current ${plain(input.current)} from ${input.currentFrom}`
      : undefined;
  if ("waived" in result) {
    const why = ["the first release that does", source].filter(Boolean).join("; ");
    const fact = `cooling: waived, ${plain(version)} fixes ${result.waived} (${why})`;
    return { lines: [`  . ${fact}`], held: false };
  }
  let msg = `cooling: ${plain(version)} was published ${age} days ago, limit ${limitDays}`;
  const older = newestOlder(input.versions, input.times, limitDays, now);
  if (older)
    msg += `; newest version public for ${limitDays} days or more: ${plain(input.pkg)}${input.pin ?? "@"}${plain(older)}`;
  const notes = [source, result.note].filter(Boolean);
  if (notes.length > 0) msg += ` (${notes.join("; ")})`;
  const line = input.enforce ? `  x CRITICAL: ${msg}` : `  ! WARNING: ${msg}`;
  return { lines: [line], held: input.enforce };
}

export async function supplyChainConfig(cwd: string): Promise<SupplyChainConfig> {
  try {
    const { loadConfig } = await import("./config.js");
    return (await loadConfig(join(cwd, ".kit.toml"))).supply_chain ?? {};
  } catch {
    return {};
  }
}

/** Air-gap as the project declares it: on or off, the mirrors it names, and whether that was unreadable. */
export interface AirGapView {
  enabled: boolean;
  mirrors: Record<string, string>;
  unreadable?: true;
}

export interface CoolingDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** GET a JSON document, or null on any failure. */
  getJson: (url: string) => Promise<unknown>;
  /** POST a JSON body and read a JSON answer, or null on any failure. */
  postJson: (url: string, body: unknown) => Promise<unknown>;
  airGap: (cwd: string) => Promise<AirGapView>;
  /** Where installed copies live, for the current version. Defaults to this machine's. */
  locator?: InstallLocator;
}

/** A registry answer with its status, so a 404 (no such name) reads apart from a failure. */
export interface RegistryDoc {
  status: number;
  body: unknown;
}

/** GET or POST a registry document: its status and JSON body, or null when it could not be read. */
export async function fetchRegistryDoc(
  url: string,
  init?: RequestInit,
): Promise<RegistryDoc | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", "user-agent": "kit-triage/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const doc = await fetchRegistryDoc(url, init);
  return doc && doc.status >= 200 && doc.status < 300 ? doc.body : null;
}

export async function airGapView(cwd: string): Promise<AirGapView> {
  const { resolveAirGap, airGapTriageEnv } = await import("./airgap/config.js");
  const file = join(cwd, ".kit.toml");
  const view = (cfg: Parameters<typeof resolveAirGap>[0]): AirGapView => {
    const settings = resolveAirGap(cfg, process.env);
    return { enabled: settings.enabled, mirrors: airGapTriageEnv(settings) };
  };
  if (!existsSync(file)) return view(undefined);
  try {
    const { loadConfig } = await import("./config.js");
    return view((await loadConfig(file)).air_gap);
  } catch {
    // A config that exists but cannot be read might declare air-gap: doubt means on.
    return { enabled: true, mirrors: {}, unreadable: true };
  }
}

export const defaultCoolingDeps: CoolingDeps = {
  env: process.env,
  now: () => Date.now(),
  getJson: (url) => fetchJson(url),
  postJson: (url, body) => fetchJson(url, { method: "POST", body: JSON.stringify(body) }),
  airGap: airGapView,
  locator: defaultInstallLocator,
};

const TRIAGED_LINE = /^\s*\. triaged ([0-9A-Za-z.+-]+)/m;

/** The version triage.py inspected, read from its report ("triaged 1.0.1, 3 versions, ..."), or null. */
export function triagedVersion(output: string): string | null {
  return TRIAGED_LINE.exec(output)?.[1] ?? null;
}

function registryUrl(base: string, pkg: string): string {
  const path = pkg
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${base.replace(/\/+$/, "")}/${path.replace(/%40/g, "@")}`;
}

export function limitFrom(cfg: SupplyChainConfig, env: NodeJS.ProcessEnv): number {
  const raw = env.KIT_MIN_RELEASE_AGE_DAYS?.trim();
  const days = raw ? Number(raw) : cfg.min_release_age_days;
  return typeof days === "number" && Number.isFinite(days) && days >= 0
    ? Math.trunc(days)
    : DEFAULT_COOLING_DAYS;
}

/**
 * Whether the cooling period holds back the pass. On unless turned off: KIT_COOLING_ENFORCE=1 or 0
 * decides for one run, as KIT_MIN_RELEASE_AGE_DAYS does for the limit, and otherwise only an explicit
 * `min_release_age_enforce = false` in .kit.toml makes it a warning.
 */
export function enforceFrom(cfg: SupplyChainConfig, env: NodeJS.ProcessEnv): boolean {
  const raw = env.KIT_COOLING_ENFORCE?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return cfg.min_release_age_enforce !== false;
}

function osvFor(
  deps: CoolingDeps,
  airGap: boolean,
  ecosystem: "npm" | "PyPI",
): OsvLookup | { skipped: string } {
  const mirror = deps.env.KIT_OSV_API?.trim();
  if (airGap && !mirror) return { skipped: "air-gap is on and no KIT_OSV_API mirror is named" };
  const base = (mirror || "https://api.osv.dev").replace(/\/+$/, "");
  return async (pkg, version) => {
    const body = { package: { name: pkg, ecosystem }, version };
    const answer = (await deps.postJson(`${base}/v1/query`, body)) as { vulns?: OsvVuln[] } | null;
    if (!answer || typeof answer !== "object") return null;
    return Array.isArray(answer.vulns) ? answer.vulns.filter((v) => typeof v?.id === "string") : [];
  };
}

/** Put the cooling lines before the score and, when the period holds the pass back, take the verdict away. */
export function withCoolingLines(output: string, result: CoolingResult): string {
  if (result.lines.length === 0) return output;
  const at = output.indexOf("\nHealth score:");
  const block = `${result.lines.join("\n")}\n`;
  const merged =
    at < 0 ? `${output}\n${block}` : `${output.slice(0, at + 1)}${block}${output.slice(at + 1)}`;
  const counted = countCoolingWarnings(merged, result.lines);
  return result.held ? counted.replace(/^TRIAGE PASSED$/m, "TRIAGE HELD: cooling period") : counted;
}

/** triage.py's flat penalties per critical and per warning (`100 - 45*crit - 12*warn`). */
const CRITICAL_PENALTY = 45;
const WARNING_PENALTY = 12;

/**
 * The summary is triage.py's, made before the cooling lines were added, so a cooling warning printed
 * above `Warnings: 0` (kit-research `supply-chain-2026-fundamentals-vs-kit`), and a cooling CRITICAL
 * above `Critical issues: 0` with the score untouched. Both counts and the score take what the cooling
 * lines add, with triage.py's own penalties; a NOT CHECKED or waived line adds nothing.
 */
function countCoolingWarnings(output: string, lines: string[]): string {
  const crit = lines.filter((l) => l.includes("x CRITICAL:")).length;
  const warn = lines.filter((l) => l.includes("! WARNING:")).length;
  if (crit + warn === 0) return output;
  const penalty = CRITICAL_PENALTY * crit + WARNING_PENALTY * warn;
  return output
    .replace(/^Critical issues: (\d+)$/m, (_, n: string) => `Critical issues: ${Number(n) + crit}`)
    .replace(/^Warnings: (\d+)$/m, (_, n: string) => `Warnings: ${Number(n) + warn}`)
    .replace(/^Health score: (\d+)\/100$/m, (_, n: string) => {
      return `Health score: ${Math.max(0, Number(n) - penalty)}/100`;
    });
}

/** The registry view the cooling check needs: published versions and their publish times. */
interface RegistryView {
  versions: string[];
  times: Record<string, string>;
}

/** Where to read one package's release times, or why it must not be read. */
export function registrySource(
  type: string,
  pkg: string,
  deps: Pick<CoolingDeps, "env">,
  air: AirGapView,
): { url: string; parse: (doc: unknown) => RegistryView | null } | { skip: string } {
  const npm = type === "npm";
  const name = npm ? "KIT_NPM_REGISTRY" : "KIT_PYPI_INDEX";
  const mirror = deps.env[name]?.trim() || air.mirrors[name];
  if (air.enabled && !mirror) {
    return {
      skip: air.unreadable
        ? "the .kit.toml could not be read, so air-gap cannot be ruled out and the registry is not queried"
        : `air-gap is on and no ${npm ? "npm registry" : "PyPI index"} mirror is named`,
    };
  }
  if (!npm) return { url: pypiJsonUrl(mirror || "https://pypi.org", pkg), parse: pypiReleaseTimes };
  return {
    url: registryUrl(mirror || "https://registry.npmjs.org", pkg),
    parse: (doc) => {
      const d = doc as { versions?: Record<string, unknown>; time?: Record<string, string> } | null;
      return d?.versions && d.time ? { versions: Object.keys(d.versions), times: d.time } : null;
    },
  };
}

/**
 * The version in use, in the order of trust: npm's lockfile, then its global install, then
 * `node_modules`; pip's installed dist-info. Installed copies count only when `published` has them.
 */
export function currentVersion(
  cwd: string,
  type: string,
  target: string,
  published: readonly string[],
  deps: CoolingDeps,
): Promise<CurrentVersion> {
  const loc = deps.locator ?? defaultInstallLocator;
  if (type === "npm") {
    const pkg = npmName(target) ?? target;
    const locked = { label: "the project lockfile", version: lockedVersion(cwd, target) };
    return resolveCurrent(locked, npmProbes(cwd, pkg, deps.env, loc), published);
  }
  const name = pipName(target) ?? target;
  return resolveCurrent(
    { label: "a lockfile (pip has none kit reads)" },
    pipProbes(cwd, name, loc),
    published,
  );
}

/** Run the cooling check for an npm or pip triage and fold it into the result. Other ecosystems pass through. */
export async function applyCooling(
  cwd: string,
  type: string,
  target: string,
  result: { passed: boolean; output: string },
  deps: CoolingDeps = defaultCoolingDeps,
): Promise<{ passed: boolean; output: string }> {
  const pkg = type === "npm" ? npmName(target) : type === "pip" ? pipName(target) : null;
  const version = triagedVersion(result.output);
  if (!pkg || !version) return result;
  const cfg = await supplyChainConfig(cwd);
  const limitDays = limitFrom(cfg, deps.env);
  if (limitDays === 0) return result;
  const enforce = enforceFrom(cfg, deps.env);
  const fold = (r: CoolingResult) => ({
    passed: r.held ? false : result.passed,
    output: withCoolingLines(result.output, r),
  });
  const air = await deps.airGap(cwd);
  // The same mirror triage.py was given: the environment first, then the one .kit.toml declares.
  const source = registrySource(type, pkg, deps, air);
  if ("skip" in source) return fold(unverified(source.skip, enforce));
  const view = source.parse(await deps.getJson(source.url));
  if (!view) return fold(unverified("the registry could not be read again", enforce));
  // Only a release inside the cooling period (or with no publish time) needs the version in use.
  const age = ageDays(view.times[version], deps.now());
  const current =
    age === undefined || age < limitDays
      ? await currentVersion(cwd, type, target, view.versions, deps)
      : {};
  const verdict = await coolingCheck({
    pkg,
    version,
    versions: view.versions,
    times: view.times,
    limitDays,
    enforce,
    current: current.version,
    currentFrom: current.from,
    currentInstalled: current.installed,
    currentNote: current.note,
    now: deps.now(),
    osv: osvFor(deps, air.enabled, type === "npm" ? "npm" : "PyPI"),
    pin: type === "npm" ? "@" : "==",
  });
  return fold(verdict);
}
