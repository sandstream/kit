/**
 * `kit triage go <package>[@version]`: a Go module release, checked before `go install`.
 *
 * `go install example.com/tool@latest` downloads, builds and installs a program in one step, and
 * the install gate let it through. The Go module proxy answers `/<module>/@latest` and
 * `/<module>/@v/<version>.info` with the version and its time, so kit's cooling period applies,
 * and OSV carries the Go vulnerability database and the malicious-packages records.
 *
 * Two limits are printed with every report, not implied: the proxy's time is the date of the
 * tagged commit, which the commit's author sets, and no module source is downloaded or read.
 */
import { defaultCoolingDeps, type CoolingDeps } from "./triage-cooling.js";
import {
  advisoryLines,
  failed,
  osvLookup,
  plain,
  registryBase,
  releaseCooling,
  releaseVerdict,
  type ReleaseTriageResult,
} from "./triage-registry.js";

const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const VERSION_QUERY = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
/** `v0.0.0-20260102150405-abcdef123456`: an untagged commit, named by its date and hash. */
const PSEUDO_VERSION = /-(?:0\.)?\d{14}-[0-9a-f]{12}(?:\+incompatible)?$/;
/** The longest import path kit walks up looking for the module that holds the package. */
const MAX_SEGMENTS = 10;

export interface GoTarget {
  /** The package import path as given: the module is this path or a prefix of it. */
  path: string;
  /** `latest`, a version such as `v1.2.3`, or another query the proxy resolves (a branch, a commit). */
  query: string;
}

/** `path` or `path@query` (go's own spelling; no query means `latest`), or null. */
export function parseGoTarget(target: string): GoTarget | null {
  const [path, query, extra] = target.trim().split("@");
  if (extra !== undefined || !path || !/^[A-Za-z0-9]/.test(path)) return null;
  const segments = path.split("/");
  const named = segments.every((s) => PATH_SEGMENT.test(s) && !/^\.+$/.test(s));
  // A module path starts with a host name: the first element holds a dot.
  if (!named || !segments[0]!.includes(".") || segments.length > MAX_SEGMENTS) return null;
  if (query === undefined) return { path, query: "latest" };
  return VERSION_QUERY.test(query) ? { path, query } : null;
}

/** The proxy's case encoding: an upper-case letter is `!` and its lower-case form. */
export function goEscape(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

export interface GoTriageDeps extends CoolingDeps {
  /** GET a text document, or null on any failure. */
  getText: (url: string) => Promise<string | null>;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "kit-triage/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** The live module proxy and OSV. */
export const defaultGoDeps: GoTriageDeps = { ...defaultCoolingDeps, getText: fetchText };

export interface GoRelease {
  module: string;
  version: string;
  time: string;
}

/** The proxy's `{Version, Time}` answer for a module, or null when it is not one. Pure. */
export function goRelease(module: string, doc: unknown): GoRelease | null {
  const d = doc as { Version?: unknown; Time?: unknown } | null;
  const version = typeof d?.Version === "string" ? d.Version : null;
  const time = typeof d?.Time === "string" ? d.Time : null;
  if (!version || !time || Number.isNaN(Date.parse(time))) return null;
  return { module, version, time };
}

/**
 * The release the query names. The module is the longest prefix of the package path that the
 * proxy knows, which is how `go install` finds it too.
 */
async function resolveRelease(
  base: string,
  target: GoTarget,
  deps: GoTriageDeps,
): Promise<GoRelease | null> {
  const segments = target.path.split("/");
  const query = target.query;
  for (let end = segments.length; end >= 1; end--) {
    const module = segments.slice(0, end).join("/");
    const at = query === "latest" ? "@latest" : `@v/${goEscape(query)}.info`;
    const release = goRelease(module, await deps.getJson(`${base}/${goEscape(module)}/${at}`));
    if (release) return release;
  }
  return null;
}

/** How many tagged versions the proxy lists for the module, or null when the list cannot be read. */
async function taggedCount(
  base: string,
  module: string,
  deps: GoTriageDeps,
): Promise<number | null> {
  const list = await deps.getText(`${base}/${goEscape(module)}/@v/list`);
  return list === null ? null : list.split("\n").filter((line) => line.trim() !== "").length;
}

function historyLines(release: GoRelease, tagged: number | null): string[] {
  const lines = [`  . triaged ${plain(release.version)} of module ${plain(release.module)}`];
  if (tagged === null)
    lines.push("  ~ NOT CHECKED: release history -- the proxy's version list could not be read");
  else lines.push(`  . ${tagged} tagged version(s) on the proxy`);
  if (PSEUDO_VERSION.test(release.version))
    lines.push(
      `  ! WARNING: ${plain(release.version)} is a pseudo-version: an untagged commit, not a release`,
    );
  return lines;
}

/** Triage one Go module release. Network through `deps` only; no module source is fetched. */
export async function triageGo(
  cwd: string,
  target: string,
  deps: GoTriageDeps = defaultGoDeps,
): Promise<ReleaseTriageResult> {
  const parsed = parseGoTarget(target);
  if (!parsed)
    return failed(`  x CRITICAL: '${plain(target)}' is not a Go package path or path@version`);
  const air = await deps.airGap(cwd);
  const base = registryBase(deps, air, "KIT_GOPROXY", "https://proxy.golang.org");
  if (!base) return failed("  x CRITICAL: air-gap is on and no KIT_GOPROXY mirror is named");
  const release = await resolveRelease(base, parsed, deps);
  if (!release)
    return failed(
      `  x CRITICAL: no module for '${plain(parsed.path)}@${plain(parsed.query)}' on ${plain(base)} (or the proxy could not be read)`,
    );

  const osv = osvLookup(deps, air.enabled, "Go");
  const cooling = await releaseCooling(cwd, deps, {
    pkg: release.module,
    version: release.version,
    versions: [release.version],
    times: { [release.version]: release.time },
    osv,
  });
  const lines = [
    ...historyLines(release, await taggedCount(base, release.module, deps)),
    // OSV's Go records name versions without the leading `v`.
    ...(await advisoryLines(osv, release.module, release.version.replace(/^v/, ""))),
    ...cooling.lines,
    "  ~ NOT CHECKED: publish time -- the proxy gives the date of the tagged commit, which the commit's author sets; the release age rests on that date",
    "  ~ NOT CHECKED: module source -- no module file was downloaded or read",
  ];
  return releaseVerdict(lines, cooling);
}
