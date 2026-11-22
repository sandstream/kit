/**
 * What the registry triages written in TypeScript share (`kit triage gem|cargo|go`): the OSV
 * lookup, the advisory lines, the cooling period with the project's limit, and the verdict.
 *
 * One rule runs through all of it: a probe that could not run prints `~ NOT CHECKED` with the
 * reason. It is never left out, because a missing line reads as a clean one.
 */
import {
  coolingCheck,
  enforceFrom,
  limitFrom,
  supplyChainConfig,
  type AirGapView,
  type CoolingDeps,
  type CoolingResult,
  type OsvLookup,
  type OsvVuln,
} from "./triage-cooling.js";

export interface ReleaseTriageResult {
  passed: boolean;
  output: string;
}

type Osv = OsvLookup | { skipped: string };

/** A registry- or advisory-supplied string made safe to print on one line. */
export function plain(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

/** A triage that stops at one critical line. */
export function failed(line: string): ReleaseTriageResult {
  return { passed: false, output: `${line}\n\nTRIAGE FAILED` };
}

/**
 * The registry base to query: the mirror `envName` names, else the public one. Null under air-gap
 * with no mirror, where nothing may be queried.
 */
export function registryBase(
  deps: CoolingDeps,
  air: Pick<AirGapView, "enabled">,
  envName: string,
  publicBase: string,
): string | null {
  const mirror = deps.env[envName]?.trim();
  if (air.enabled && !mirror) return null;
  return (mirror || publicBase).replace(/\/+$/, "");
}

function osvBase(deps: CoolingDeps, airGap: boolean): string | null {
  return registryBase(deps, { enabled: airGap }, "KIT_OSV_API", "https://api.osv.dev");
}

/** An OSV lookup for one ecosystem, or the reason advisories must not be queried (air-gap). */
export function osvLookup(deps: CoolingDeps, airGap: boolean, ecosystem: string): Osv {
  const base = osvBase(deps, airGap);
  if (!base) return { skipped: "air-gap is on and no KIT_OSV_API mirror is named" };
  return async (pkg, version) => {
    const body = { package: { name: pkg, ecosystem }, version };
    const answer = (await deps.postJson(`${base}/v1/query`, body)) as { vulns?: OsvVuln[] } | null;
    if (!answer || typeof answer !== "object") return null;
    return Array.isArray(answer.vulns) ? answer.vulns.filter((v) => typeof v?.id === "string") : [];
  };
}

/** Advisory lines: a MAL- record is a malicious package; any other record is a known vulnerability. */
export async function advisoryLines(osv: Osv, name: string, version: string): Promise<string[]> {
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

/** Malicious-package records OSV holds for a name, any version; [] when none or not asked. */
export async function maliciousByName(
  deps: CoolingDeps,
  airGap: boolean,
  ecosystem: string,
  name: string,
): Promise<string[]> {
  const base = osvBase(deps, airGap);
  if (!base) return [];
  const answer = (await deps.postJson(`${base}/v1/query`, {
    package: { name, ecosystem },
  })) as { vulns?: OsvVuln[] } | null;
  const ids = (answer?.vulns ?? []).map((v) => v?.id).filter((id) => id?.startsWith("MAL-"));
  return ids.length
    ? [`  x CRITICAL: malicious package: ${ids.map((id) => plain(id)).join(", ")} (OSV)`]
    : [];
}

export interface ReleaseCooling {
  pkg: string;
  version: string;
  versions: string[];
  times: Record<string, string>;
  osv: Osv;
  /** The version the project's lockfile pins now, when kit reads one. */
  current?: string;
}

/** The cooling check with the limit and enforcement npm and pip use: `[supply_chain]`, then the environment. */
export async function releaseCooling(
  cwd: string,
  deps: CoolingDeps,
  release: ReleaseCooling,
): Promise<CoolingResult> {
  const cfg = await supplyChainConfig(cwd);
  return coolingCheck({
    ...release,
    limitDays: limitFrom(cfg, deps.env),
    enforce: enforceFrom(cfg, deps.env),
    now: deps.now(),
  });
}

/** The report and its verdict. A cooling hold is its own verdict, not a failure: the release may pass once it is old enough. */
export function releaseVerdict(lines: string[], cooling: CoolingResult): ReleaseTriageResult {
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
