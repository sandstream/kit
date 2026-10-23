/**
 * Runtime currency for `kit check`: a row per Node, PHP or Python interpreter the project uses.
 * A tools row that says `node 24.13.1 (need 24)` compared only the major, so it stayed green for a
 * release line that had a security fix. This reads the vendors' release data and answers per
 * runtime: a security release the installed version lacks, or an end-of-life line, is a failure; a
 * plain patch is a warning; and a source that holds nothing current is `unverified`, a warning that
 * is never green. `kit check` stays offline-safe: it reads the cache only (filled by `kit upstream
 * check`, or by `kit check --online`), and a cache older than a day counts as absent.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { assessFromLookup, serviceFor } from "./upstream-runtime-report.js";
import { detectRuntimes, readInstalledVersion, RUNTIME_SPECS } from "./upstream-runtimes.js";
import type { RuntimeAssessment, RuntimeSpec } from "./upstream-runtimes.js";
import { lookupUpstream } from "./upstream-sources.js";
import type { UpstreamLookup, UpstreamService } from "./upstream-sources.js";

const GATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_CHARS = 160;

export interface RuntimeCheckDeps {
  readInstalled?: (spec: RuntimeSpec, root: string) => Promise<string | null>;
  lookup?: (
    service: UpstreamService,
    opts: { cacheOnly: boolean; ttlMs: number },
  ) => Promise<UpstreamLookup>;
  now?: () => number;
  /** Fetch instead of reading the cache only. CI uses this; a normal run does not. */
  online?: boolean;
}

const BREW: Record<string, string> = { node: "node", php: "php", python: "python@3" };

function upgradeHint(spec: RuntimeSpec, latest: string): string {
  return `mise install ${spec.id}@${latest}  (or: brew upgrade ${BREW[spec.id]})`;
}

function firstEvidence(evidence: readonly string[]): string {
  const line = evidence.find((l) => /CVE-/.test(l)) ?? evidence[0] ?? "";
  return line.slice(0, MAX_EVIDENCE_CHARS);
}

interface RowContext {
  spec: RuntimeSpec;
  label: string;
  name: string;
  a: RuntimeAssessment;
}

const FIX_CACHE = "kit upstream check  (fills the cache), or kit check --online";

function unverified(c: RowContext, why: string): SecurityCheckResult {
  return {
    category: "supply-chain",
    name: c.name,
    status: "warn",
    severity: "medium",
    detail: `${c.label}: unverified, ${why}`,
    suggestion: FIX_CACHE,
  };
}

/** One builder per verdict. A verdict with no builder is unverified, so a new one cannot read as green. */
const BUILDERS: Partial<
  Record<RuntimeAssessment["verdict"], (c: RowContext) => SecurityCheckResult>
> = {
  "end of life": (c) => ({
    category: "supply-chain",
    name: c.name,
    status: "fail",
    severity: "high",
    detail: `${c.label}: ${firstEvidence(c.a.evidence)}`,
    suggestion: `move to a supported ${c.spec.label} release line: mise use ${c.spec.id}@<supported>`,
  }),
  "security release available": (c) => ({
    category: "supply-chain",
    name: c.name,
    status: "fail",
    severity: "high",
    detail: `${c.label}: ${c.a.latest} is a security release. ${firstEvidence(c.a.evidence)}`,
    suggestion: upgradeHint(c.spec, c.a.latest ?? "latest"),
  }),
  "patch available": (c) => ({
    category: "supply-chain",
    name: c.name,
    status: "warn",
    severity: "low",
    detail: `${c.label}: ${c.a.latest} is out${c.a.detail ? ` (${c.a.detail})` : ""}`,
    suggestion: upgradeHint(c.spec, c.a.latest ?? "latest"),
  }),
  current: (c) => ({
    category: "supply-chain",
    name: c.name,
    status: "pass",
    detail: `${c.label} is the newest release of its line${c.a.supportedUntil ? `, supported until ${c.a.supportedUntil}` : ""}`,
  }),
};

function rowFor(
  spec: RuntimeSpec,
  installed: string | null,
  a: RuntimeAssessment,
  skipped: string | undefined,
): SecurityCheckResult {
  const c: RowContext = {
    spec,
    a,
    name: `runtime: ${spec.id}`,
    label: `${spec.label} ${installed ?? "?"}`,
  };
  if (skipped !== undefined) return unverified(c, `skipped (${skipped})`);
  const build = BUILDERS[a.verdict];
  return build ? build(c) : unverified(c, a.detail ?? "no current data");
}

export async function checkRuntimes(
  root: string,
  deps: RuntimeCheckDeps = {},
): Promise<SecurityCheckResult[]> {
  const readInstalled = deps.readInstalled ?? readInstalledVersion;
  const lookup =
    deps.lookup ??
    ((service: UpstreamService, opts: { cacheOnly: boolean; ttlMs: number }) =>
      lookupUpstream(service, { cacheOnly: opts.cacheOnly, ttlMs: opts.ttlMs }));
  const now = deps.now ?? Date.now;
  const rows: SecurityCheckResult[] = [];
  for (const detected of detectRuntimes(root)) {
    const spec = RUNTIME_SPECS.find((s) => s.id === detected.id) as RuntimeSpec;
    const installed = await readInstalled(spec, root);
    const found = await lookup(serviceFor(spec), {
      cacheOnly: deps.online !== true,
      ttlMs: GATE_TTL_MS,
    });
    const skipped = found.status === "skipped" ? (found.reason ?? "no network") : undefined;
    rows.push(rowFor(spec, installed, assessFromLookup(spec, installed, found, now()), skipped));
  }
  return rows;
}
