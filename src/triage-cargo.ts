/**
 * `kit triage cargo <crate>[@version]`: a crates.io release, checked before `cargo install`.
 *
 * The install gate covered npm, PyPI and RubyGems and let `cargo install` through, so a program
 * refused as a one-day-old npm package installed as a one-day-old crate. crates.io gives each
 * version's publish time and whether it was yanked, so kit's cooling period applies as it does to
 * npm, pip and gem, and OSV carries the RustSec and malicious-packages records for crates.io.
 *
 * What it cannot see is said, not implied: no crate file is downloaded or read, and a crate's
 * `build.rs` and procedural macros run on the machine during `cargo install`.
 */
import { defaultCoolingDeps, type CoolingDeps } from "./triage-cooling.js";
import {
  advisoryLines,
  failed,
  maliciousByName,
  osvLookup,
  plain,
  registryBase,
  releaseCooling,
  releaseVerdict,
  type ReleaseTriageResult,
} from "./triage-registry.js";

const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CRATE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$/;
const DAY_MS = 86_400_000;
/** A crate first published this recently has no history to judge it by. */
const NEW_CRATE_DAYS = 30;
/** Fewer lifetime downloads than this: almost nobody runs it. */
const LOW_DOWNLOADS = 1_000;

export interface CrateTarget {
  name: string;
  version?: string;
}

/** `name` or `name@version` (cargo's own spelling), or null. */
export function parseCrateTarget(target: string): CrateTarget | null {
  const [name, version, extra] = target.trim().split("@");
  if (extra !== undefined || !CRATE_NAME.test(name ?? "")) return null;
  if (version === undefined) return { name };
  return CRATE_VERSION.test(version) ? { name, version } : null;
}

/** One entry of `versions` in `GET /api/v1/crates/<name>`, as far as triage reads it. */
interface CrateVersionRow {
  num?: unknown;
  created_at?: unknown;
  yanked?: unknown;
}

export interface CrateView {
  /** Published version numbers that were not yanked. */
  versions: string[];
  times: Record<string, string>;
  yanked: Set<string>;
  downloads: number;
  /** The version `cargo install <name>` takes: the highest stable one that is not yanked. */
  stable?: string;
}

function crateRow(row: CrateVersionRow | null | undefined) {
  const version = typeof row?.num === "string" ? row.num : null;
  const at = typeof row?.created_at === "string" ? row.created_at : null;
  if (!version || !at || Number.isNaN(Date.parse(at))) return null;
  return { version, at, yanked: row?.yanked === true };
}

/** The newest version by publish time that is neither yanked nor a prerelease. */
function newestStable(view: CrateView): string | undefined {
  return view.versions
    .filter((v) => !v.includes("-"))
    .sort((a, b) => Date.parse(view.times[b]) - Date.parse(view.times[a]))[0];
}

/** The crate document as a registry view, or null when it is not one. Pure. */
export function crateView(doc: unknown): CrateView | null {
  const d = doc as {
    crate?: { downloads?: unknown; max_stable_version?: unknown };
    versions?: unknown;
  } | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.versions)) return null;
  const downloads = typeof d.crate?.downloads === "number" ? d.crate.downloads : 0;
  const view: CrateView = { versions: [], times: {}, yanked: new Set(), downloads };
  for (const raw of d.versions as CrateVersionRow[]) {
    const row = crateRow(raw);
    if (!row) continue;
    view.times[row.version] = row.at;
    if (row.yanked) view.yanked.add(row.version);
    else view.versions.push(row.version);
  }
  if (Object.keys(view.times).length === 0) return null;
  const declared = d.crate?.max_stable_version;
  view.stable =
    typeof declared === "string" && view.versions.includes(declared)
      ? declared
      : newestStable(view);
  return view;
}

/** Owner logins from `GET /api/v1/crates/<name>/owners`, or null when the answer is not one. Pure. */
export function crateOwners(doc: unknown): string[] | null {
  const users = (doc as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return null;
  return users
    .map((u) => (u as { login?: unknown } | null)?.login)
    .filter((login): login is string => typeof login === "string");
}

function ownerLine(owners: string[] | null): string {
  if (!owners) return "  ~ NOT CHECKED: owners -- the crates.io owners list could not be read";
  const shown = owners.slice(0, 5).map(plain).join(", ");
  return `  . ${owners.length} owner(s)${shown ? `: ${shown}` : ""}`;
}

/** Report lines (triage.py's format) for what the registry says about the crate as a whole. */
function historyLines(view: CrateView, version: string, now: number): string[] {
  const first = Object.values(view.times).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const published = Object.keys(view.times).length;
  const lines = [
    `  . triaged ${plain(version)}, ${published} version(s), ${view.downloads} downloads in total`,
  ];
  const age = Math.floor((now - Date.parse(first)) / DAY_MS);
  if (age < NEW_CRATE_DAYS)
    lines.push(
      `  ! WARNING: new crate: first published ${age} day(s) ago (under ${NEW_CRATE_DAYS})`,
    );
  if (view.downloads < LOW_DOWNLOADS)
    lines.push(
      `  ! WARNING: ${view.downloads} downloads across all versions (under ${LOW_DOWNLOADS})`,
    );
  return lines;
}

/** Why the version cannot be triaged, or null when it is published and not yanked. */
function unpublished(view: CrateView, name: string, version: string | undefined): string | null {
  if (!version) return `  x CRITICAL: ${plain(name)} has no stable version that is not yanked`;
  const label = `${plain(name)}@${plain(version)}`;
  if (view.yanked.has(version)) return `  x CRITICAL: ${label} was yanked from the registry`;
  return view.times[version] ? null : `  x CRITICAL: ${label} is not published`;
}

/** Triage one crate release. Network through `deps` only; no crate file is fetched. */
export async function triageCargo(
  cwd: string,
  target: string,
  deps: CoolingDeps = defaultCoolingDeps,
): Promise<ReleaseTriageResult> {
  const parsed = parseCrateTarget(target);
  if (!parsed)
    return failed(`  x CRITICAL: '${plain(target)}' is not a crate name or name@version`);
  const air = await deps.airGap(cwd);
  const base = registryBase(deps, air, "KIT_CRATES_REGISTRY", "https://crates.io");
  if (!base)
    return failed("  x CRITICAL: air-gap is on and no KIT_CRATES_REGISTRY mirror is named");
  const url = `${base}/api/v1/crates/${encodeURIComponent(parsed.name)}`;
  const view = crateView(await deps.getJson(url));
  if (!view) {
    // A removed crate is often a malicious one: say so when OSV knows, since the registry no longer can.
    const known = await maliciousByName(deps, air.enabled, "crates.io", parsed.name);
    const line = `  x CRITICAL: crate '${plain(parsed.name)}' not found on ${plain(base)} (or the registry could not be read)`;
    return failed([line, ...known].join("\n"));
  }
  const version = parsed.version ?? view.stable;
  const missing = unpublished(view, parsed.name, version);
  if (missing || !version) return failed(missing ?? "  x CRITICAL: no version to triage");

  const osv = osvLookup(deps, air.enabled, "crates.io");
  const cooling = await releaseCooling(cwd, deps, {
    pkg: parsed.name,
    version,
    versions: view.versions,
    times: view.times,
    osv,
  });
  const lines = [
    ...historyLines(view, version, deps.now()),
    ownerLine(crateOwners(await deps.getJson(`${url}/owners`))),
    ...(await advisoryLines(osv, parsed.name, version)),
    ...cooling.lines,
    "  ~ NOT CHECKED: build-time code -- a crate's build.rs and procedural macros run during cargo install; no crate file was downloaded or read",
  ];
  return releaseVerdict(lines, cooling);
}
