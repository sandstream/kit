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
import { join } from "node:path";
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
import { readRegularFileIfPresent } from "./upstream-safe-read.js";

const GEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY_MS = 86_400_000;
/** A gem first published this recently has no history to judge it by. */
const NEW_GEM_DAYS = 30;
/** Fewer lifetime downloads than this across all versions: almost nobody runs it. */
const LOW_DOWNLOADS = 1_000;

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

/** One usable row: a version with a publish time, or null. */
function gemRow(row: GemVersionRow | null | undefined) {
  const version = typeof row?.number === "string" ? row.number : null;
  const at = typeof row?.created_at === "string" ? row.created_at : null;
  if (!version || !at || Number.isNaN(Date.parse(at))) return null;
  return {
    version,
    at,
    prerelease: row?.prerelease === true,
    downloads: typeof row?.downloads_count === "number" ? row.downloads_count : 0,
    mfa: row?.metadata?.rubygems_mfa_required === "true",
  };
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
  for (const raw of doc as GemVersionRow[]) {
    const row = gemRow(raw);
    if (!row) continue;
    const seen = view.times[row.version];
    if (!seen) view.versions.push(row.version);
    if (!seen || Date.parse(row.at) < Date.parse(seen)) view.times[row.version] = row.at;
    if (row.prerelease) view.prerelease.add(row.version);
    view.downloads += row.downloads;
    view.mfaRequired[row.version] ||= row.mfa;
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

/** The live registry, OSV and the project's Gemfile.lock. */
export const defaultGemDeps: GemTriageDeps = {
  ...defaultCoolingDeps,
  lockfile: (cwd) => {
    try {
      return readRegularFileIfPresent(join(cwd, "Gemfile.lock"));
    } catch {
      return null;
    }
  },
};

export type GemTriageResult = ReleaseTriageResult;

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

/** Triage one gem release. Network through `deps` only; no gem code is fetched. */
export async function triageGem(
  cwd: string,
  target: string,
  deps: GemTriageDeps,
): Promise<GemTriageResult> {
  const parsed = parseGemTarget(target);
  if (!parsed) return failed(`  x CRITICAL: '${plain(target)}' is not a gem name or name@version`);
  const air = await deps.airGap(cwd);
  const base = registryBase(deps, air, "KIT_RUBYGEMS_SOURCE", "https://rubygems.org");
  if (!base)
    return failed("  x CRITICAL: air-gap is on and no KIT_RUBYGEMS_SOURCE mirror is named");
  const doc = await deps.getJson(`${base}/api/v1/versions/${encodeURIComponent(parsed.name)}.json`);
  const view = gemRegistryView(doc);
  if (!view) {
    // A removed gem is often a malicious one: say so when OSV knows, since the registry no longer can.
    const known = await maliciousByName(deps, air.enabled, "RubyGems", parsed.name);
    return failed(
      [`  x CRITICAL: gem '${plain(parsed.name)}' not found on ${plain(base)}`, ...known].join(
        "\n",
      ),
    );
  }
  const version = parsed.version ?? newestStable(view);
  if (!version || !view.times[version])
    return failed(
      `  x CRITICAL: ${plain(parsed.name)}@${plain(String(version))} is not published (or was yanked)`,
    );

  const osv = osvLookup(deps, air.enabled, "RubyGems");
  const cooling = await releaseCooling(cwd, deps, {
    pkg: parsed.name,
    version,
    versions: view.versions,
    times: view.times,
    current: lockedGemVersion(deps.lockfile(cwd), parsed.name),
    osv,
  });
  const lines = [
    ...historyLines(view, version, deps.now()),
    ...(await advisoryLines(osv, parsed.name, version)),
    ...cooling.lines,
    "  ~ NOT CHECKED: install-time code -- the registry does not say whether the gem has a native extension (extconf.rb runs during gem install); no gem file was downloaded or read",
  ];
  return releaseVerdict(lines, cooling);
}
