/**
 * `kit triage gem <name>[@version]`: a RubyGems release, checked before `gem install`.
 *
 * kit had no gem triage, and the bash gate passed `gem install` and `bundle install` with no
 * output. strutil-core 1.0.1 (2026-11-01) ran a credential-stealing worm from its `extconf.rb`
 * during install; it was about two hours old when published and gone after about five
 * (kit-research `strutil-core-gem-worm-vs-kit`). The RubyGems API gives each version's publish
 * time, so kit's cooling period applies as it does to npm and pip, and OSV carries the OpenSSF
 * malicious-packages feed for RubyGems.
 *
 * What it cannot see is said, not implied: the registry API does not say whether a gem has a
 * native extension, and no gem code is downloaded or read.
 */
import {
  coolingCheck,
  limitFrom,
  supplyChainConfig,
  type CoolingDeps,
  type OsvVuln,
} from "./triage-cooling.js";

const GEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY_MS = 86_400_000;
/** A gem first published this recently has no history to judge it by. */
export const NEW_GEM_DAYS = 30;
/** Fewer lifetime downloads than this across all versions: almost nobody runs it. */
export const LOW_DOWNLOADS = 1_000;

export interface GemTarget {
  name: string;
  version?: string;
}

/** `name` or `name@version` (kit's spelling; `gem` itself takes `-v`), or null. */
export function parseGemTarget(target: string): GemTarget | null {
  const [name, version, extra] = target.trim().split("@");
  if (extra !== undefined || !GEM_NAME.test(name ?? "")) return null;
  if (version === undefined) return { name };
  return /^[0-9][0-9A-Za-z.-]*$/.test(version) ? { name, version } : null;
}

/** One row of `GET /api/v1/versions/<name>.json`, as far as triage reads it. */
interface GemVersionRow {
  number?: unknown;
  created_at?: unknown;
  prerelease?: unknown;
  downloads_count?: unknown;
  metadata?: { rubygems_mfa_required?: unknown; source_code_uri?: unknown };
}

export interface GemRegistryView {
  /** Published version numbers, newest first as the API lists them, each once. */
  versions: string[];
  /** Each version's earliest publish time across its platforms. */
  times: Record<string, string>;
  prerelease: Set<string>;
  downloads: number;
  mfaRequired: Record<string, boolean>;
}

/** The versions document as a registry view, or null when it is not one. Pure. */
export function gemRegistryView(doc: unknown): GemRegistryView | null {
  if (!Array.isArray(doc)) return null;
  const view: GemRegistryView = {
    versions: [],
    times: {},
    prerelease: new Set(),
    downloads: 0,
    mfaRequired: {},
  };
  for (const row of doc as GemVersionRow[]) {
    const v = typeof row?.number === "string" ? row.number : null;
    const at = typeof row?.created_at === "string" ? row.created_at : null;
    if (!v || !at || Number.isNaN(Date.parse(at))) continue;
    if (!(v in view.times)) view.versions.push(v);
    if (!view.times[v] || Date.parse(at) < Date.parse(view.times[v])) view.times[v] = at;
    if (row.prerelease === true) view.prerelease.add(v);
    if (typeof row.downloads_count === "number") view.downloads += row.downloads_count;
    view.mfaRequired[v] ||= row.metadata?.rubygems_mfa_required === "true";
  }
  return view.versions.length > 0 ? view : null;
}

/** The version `gem install <name>` would take: the newest that is not a prerelease. */
function newestStable(view: GemRegistryView): string | undefined {
  return [...view.versions]
    .filter((v) => !view.prerelease.has(v))
    .sort((a, b) => Date.parse(view.times[b]) - Date.parse(view.times[a]))[0];
}

/** The version a Gemfile.lock pins for the gem, read from its `specs:` lines, or undefined. Pure. */
export function lockedGemVersion(lockfile: string | null, name: string): string | undefined {
  if (!lockfile) return undefined;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^ {4}${esc} \\(([^)\\s-]+)(?:-[^)]*)?\\)$`, "m").exec(lockfile)?.[1];
}

export interface GemTriageDeps extends CoolingDeps {
  /** Gemfile.lock text of the project, or null when there is none. */
  lockfile: (cwd: string) => string | null;
}

export interface GemTriageResult {
  passed: boolean;
  output: string;
}

function osvGem(deps: CoolingDeps, airGap: boolean) {
  const mirror = deps.env.KIT_OSV_API?.trim();
  if (airGap && !mirror) return { skipped: "air-gap is on and no KIT_OSV_API mirror is named" };
  const base = (mirror || "https://api.osv.dev").replace(/\/+$/, "");
  return async (pkg: string, version: string): Promise<OsvVuln[] | null> => {
    const body = { package: { name: pkg, ecosystem: "RubyGems" }, version };
    const answer = (await deps.postJson(`${base}/v1/query`, body)) as { vulns?: OsvVuln[] } | null;
    if (!answer || typeof answer !== "object") return null;
    return Array.isArray(answer.vulns) ? answer.vulns.filter((v) => typeof v?.id === "string") : [];
  };
}

function plain(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

function ageDays(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / DAY_MS);
}

/** Report lines (triage.py's format) for what the registry says about the gem as a whole. */
function historyLines(view: GemRegistryView, version: string, now: number): string[] {
  const first = Object.values(view.times).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const lines = [
    `  . triaged ${plain(version)}, ${view.versions.length} version(s), ${view.downloads} downloads in total`,
  ];
  const age = ageDays(first, now);
  if (age < NEW_GEM_DAYS)
    lines.push(`  ! WARNING: new gem: first published ${age} day(s) ago (under ${NEW_GEM_DAYS})`);
  if (view.downloads < LOW_DOWNLOADS)
    lines.push(
      `  ! WARNING: ${view.downloads} downloads across all versions (under ${LOW_DOWNLOADS})`,
    );
  if (!view.mfaRequired[version])
    lines.push(`  . ${plain(version)} does not declare rubygems_mfa_required`);
  return lines;
}

/** Advisory lines: a MAL- record is a malicious package; any other record is a known vulnerability. */
async function advisoryLines(
  osv: ReturnType<typeof osvGem>,
  name: string,
  version: string,
): Promise<string[]> {
  if (typeof osv !== "function") return [`  ~ NOT CHECKED: advisories -- ${osv.skipped}`];
  const vulns = await osv(name, version);
  if (vulns === null) return ["  ~ NOT CHECKED: advisories -- OSV could not be queried"];
  const malicious = vulns.filter((v) => v.id.startsWith("MAL-")).map((v) => plain(v.id));
  const other = vulns.filter((v) => !v.id.startsWith("MAL-")).map((v) => plain(v.id));
  const lines: string[] = [];
  if (malicious.length)
    lines.push(`  x CRITICAL: malicious package: ${malicious.join(", ")} (OSV)`);
  if (other.length)
    lines.push(`  ! WARNING: known vulnerabilities in ${plain(version)}: ${other.join(", ")}`);
  return lines;
}

/** Malicious-package records OSV holds for a gem name, any version; [] when none or not asked. */
async function removedGemAdvisories(
  deps: CoolingDeps,
  airGap: boolean,
  name: string,
): Promise<string[]> {
  const mirror = deps.env.KIT_OSV_API?.trim();
  if (airGap && !mirror) return [];
  const base = (mirror || "https://api.osv.dev").replace(/\/+$/, "");
  const answer = (await deps.postJson(`${base}/v1/query`, {
    package: { name, ecosystem: "RubyGems" },
  })) as { vulns?: OsvVuln[] } | null;
  const ids = (answer?.vulns ?? []).map((v) => v?.id).filter((id) => id?.startsWith("MAL-"));
  return ids.length
    ? [`  x CRITICAL: malicious package: ${ids.map((id) => plain(id)).join(", ")} (OSV)`]
    : [];
}

/** Triage one gem release. Network through `deps` only; no gem code is fetched. */
export async function triageGem(
  cwd: string,
  target: string,
  deps: GemTriageDeps,
): Promise<GemTriageResult> {
  const fail = (line: string) => ({ passed: false, output: `${line}\n\nTRIAGE FAILED` });
  const parsed = parseGemTarget(target);
  if (!parsed) return fail(`  x CRITICAL: '${plain(target)}' is not a gem name or name@version`);
  const air = await deps.airGap(cwd);
  const mirror = deps.env.KIT_RUBYGEMS_SOURCE?.trim();
  if (air.enabled && !mirror)
    return fail("  x CRITICAL: air-gap is on and no KIT_RUBYGEMS_SOURCE mirror is named");
  const base = (mirror || "https://rubygems.org").replace(/\/+$/, "");
  const doc = await deps.getJson(`${base}/api/v1/versions/${encodeURIComponent(parsed.name)}.json`);
  const view = gemRegistryView(doc);
  if (!view) {
    // A removed gem is often a malicious one: say so when OSV knows, since the registry no longer can.
    const known = await removedGemAdvisories(deps, air.enabled, parsed.name);
    return fail(
      [`  x CRITICAL: gem '${plain(parsed.name)}' not found on ${plain(base)}`, ...known].join(
        "\n",
      ),
    );
  }
  const version = parsed.version ?? newestStable(view);
  if (!version || !view.times[version])
    return fail(
      `  x CRITICAL: ${plain(parsed.name)}@${plain(String(version))} is not published (or was yanked)`,
    );

  const now = deps.now();
  const osv = osvGem(deps, air.enabled);
  // The same limit and enforcement as npm and pip: [supply_chain] in .kit.toml, then the environment.
  const cfg = await supplyChainConfig(cwd);
  const limitDays = limitFrom(cfg, deps.env);
  const enforce = cfg.min_release_age_enforce === true || deps.env.KIT_COOLING_ENFORCE === "1";
  const cooling = await coolingCheck({
    pkg: parsed.name,
    version,
    versions: view.versions,
    times: view.times,
    limitDays,
    enforce,
    current: lockedGemVersion(deps.lockfile(cwd), parsed.name),
    now,
    osv,
  });
  const lines = [
    ...historyLines(view, version, now),
    ...(await advisoryLines(osv, parsed.name, version)),
    ...cooling.lines,
    "  ~ NOT CHECKED: install-time code -- the registry does not say whether the gem has a native extension (extconf.rb runs during gem install); no gem file was downloaded or read",
  ];
  // A cooling hold is its own verdict, not a failure: the release may pass once it is old enough.
  const critical = lines.filter(
    (l) => l.includes(" x CRITICAL:") && !cooling.lines.includes(l),
  ).length;
  const warnings = lines.filter((l) => l.includes(" ! WARNING:")).length;
  const passed = critical === 0 && !cooling.held;
  const verdict =
    critical > 0 ? "TRIAGE FAILED" : cooling.held ? "TRIAGE HELD: cooling period" : "TRIAGE PASSED";
  const summary = `Critical issues: ${critical}\nWarnings: ${warnings}\n${verdict}`;
  return { passed, output: `${lines.join("\n")}\n\n${summary}` };
}
