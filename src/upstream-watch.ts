/**
 * Upstream watch — has anything kit depends on moved, or died, since someone last looked?
 *
 * kit's plugins have no npm dependencies; what they depend on is a vendor API (Stripe, Vercel,
 * Supabase, …). kit's scanners are delegated binaries (trivy, hadolint, …). Neither shows up
 * in a lockfile, so nothing in `kit check` or the PR-time triage gate ever re-reads them. A
 * dependency triaged once was never looked at again.
 *
 * This module compares what an upstream says NOW against a committed baseline
 * (`contracts/upstream-watch.json`) and classifies each entry. It is generalised from
 * `bumblebee-update.ts`, and shares its rule: the answer depends on the network and on someone
 * else's release schedule, so it is NEVER part of a `kit check` verdict. It runs as its own
 * scheduled workflow (`.github/workflows/upstream-watch.yml`) that opens an issue.
 *
 * Pure: every observer takes an injected `fetchJson`, so this file makes no network call of
 * its own. `scripts/upstream-watch.mjs` supplies the real one.
 *
 * Only unambiguous signals are used. An unauthenticated HTTP status is NOT one: measured
 * 2026-10-23, Supabase answers 401 to an existing path and to a made-up one alike.
 */

export type Track = "major" | "minor" | "patch";

export type Source =
  | { kind: "npm"; package: string }
  | { kind: "pypi"; package: string }
  | { kind: "github-release"; repo: string }
  /** A vendor's public list of supported API versions; `pinned` is the one kit sends. */
  | { kind: "api-versions"; url: string; pinned: string }
  /** A vendor's public OpenAPI spec; `paths` are the ones kit's plugin calls. */
  | { kind: "openapi-paths"; url: string; paths: string[]; acknowledged?: Record<string, string> }
  | { kind: "none"; reason: string };

export interface WatchEntry {
  id: string;
  /** Where kit pins or calls it, so a finding points at the file to change. */
  owner: string;
  /** What kit pins, when it pins anything. "latest" is reported as unpinned. */
  pinned?: string;
  track?: Track;
  source: Source;
  baseline?: { version?: string; observedAt: string } | null;
}

export interface Observation {
  version?: string;
  /** Reasons the upstream is gone, deprecated or no longer accepts what kit sends. */
  dead: string[];
  /** Informational lines, never a state on their own. */
  notes: string[];
}

export type WatchState =
  | "lookup-failed"
  | "dead"
  | "changed"
  | "unobserved"
  | "unchanged"
  | "not-watchable";

export interface WatchResult {
  id: string;
  owner: string;
  state: WatchState;
  detail: string;
  observed?: Observation;
}

export type FetchJson = (url: string) => Promise<unknown>;

/** Numeric components of a version string; `v1.2.3-rc.1` → [1, 2, 3]. */
function components(version: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  return m ? [m[1], m[2] ?? "0", m[3] ?? "0"].map(Number) : null;
}

/**
 * Do two versions differ at the tracked granularity? Non-numeric versions (a Snyk API date
 * such as `2024-10-15` parses as numeric, a tag such as `nightly` does not) compare exactly.
 * For 0.x, "major" means the minor: 0.3 → 0.4 is the breaking step there.
 */
export function versionsDiffer(a: string, b: string, track: Track = "patch"): boolean {
  const x = components(a);
  const y = components(b);
  if (!x || !y) return a !== b;
  const depth = track === "major" ? (x[0] === 0 && y[0] === 0 ? 2 : 1) : track === "minor" ? 2 : 3;
  return x.slice(0, depth).join(".") !== y.slice(0, depth).join(".");
}

/** `/v9/projects/${id}/env` and `/v9/projects/{idOrName}/env` both → `/v9/projects/{}/env`. */
export function normalizePath(path: string): string {
  return path
    .split("?")[0]
    .replace(/\$\{[^}]*\}|\{[^}]*\}/g, "{}")
    .replace(/\/+$/, "");
}

/**
 * The only hosts the watch may contact. The contract is reviewed code, but a URL in it still
 * should not be able to point the runner, or the GitHub token it carries, anywhere else.
 */
export const WATCH_HOSTS = new Set([
  "registry.npmjs.org",
  "pypi.org",
  "api.github.com",
  "api.snyk.io",
  "api.supabase.com",
  "openapi.vercel.sh",
]);

/** Names and versions from the contract and from registries, before they reach a URL or a report. */
const SAFE_NAME = /^(@[a-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_VERSION = /^[A-Za-z0-9._+~-]{1,64}$/;

export function assertWatchedUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" || !WATCH_HOSTS.has(u.hostname)) {
    throw new Error(`refusing ${url}: not an https URL on a watched host`);
  }
}

function assertSafeSource(source: Source): void {
  const bad =
    (source.kind === "npm" || source.kind === "pypi") && !SAFE_NAME.test(source.package)
      ? source.package
      : source.kind === "github-release" && !SAFE_REPO.test(source.repo)
        ? source.repo
        : null;
  if (bad !== null) throw new Error(`refusing malformed name ${JSON.stringify(bad)}`);
}

const registryName = (pkg: string) => encodeURIComponent(pkg);

type Observer<K extends Source["kind"]> = (
  source: Extract<Source, { kind: K }>,
  fetchJson: FetchJson,
) => Promise<Observation>;

const observeNpm: Observer<"npm"> = async (source, fetchJson) => {
  const doc = (await fetchJson(`https://registry.npmjs.org/${registryName(source.package)}`)) as {
    "dist-tags"?: { latest?: string };
    versions?: Record<string, { deprecated?: string }>;
  };
  const version = doc["dist-tags"]?.latest;
  if (!version) throw new Error(`npm has no latest tag for ${source.package}`);
  const deprecated = doc.versions?.[version]?.deprecated;
  const dead = deprecated
    ? [`npm marks ${source.package}@${version} deprecated: ${deprecated}`]
    : [];
  return { version, dead, notes: [] };
};

const observePypi: Observer<"pypi"> = async (source, fetchJson) => {
  const doc = (await fetchJson(`https://pypi.org/pypi/${source.package}/json`)) as {
    info?: { version?: string; yanked?: boolean; yanked_reason?: string | null };
  };
  const version = doc.info?.version;
  if (!version) throw new Error(`PyPI has no version for ${source.package}`);
  const why = doc.info?.yanked_reason ?? "no reason given";
  const dead = doc.info?.yanked ? [`PyPI yanked ${source.package} ${version}: ${why}`] : [];
  return { version, dead, notes: [] };
};

const observeGithubRelease: Observer<"github-release"> = async (source, fetchJson) => {
  const repo = (await fetchJson(`https://api.github.com/repos/${source.repo}`)) as {
    archived?: boolean;
  };
  const release = (await fetchJson(
    `https://api.github.com/repos/${source.repo}/releases/latest`,
  )) as { tag_name?: string };
  if (!release.tag_name) throw new Error(`${source.repo} has no latest release`);
  const dead = repo.archived ? [`${source.repo} is archived`] : [];
  return { version: release.tag_name, dead, notes: [] };
};

const observeApiVersions: Observer<"api-versions"> = async (source, fetchJson) => {
  const list = await fetchJson(source.url);
  if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) {
    throw new Error(`${source.url} did not return a list of version strings`);
  }
  // Pre-release channels (Snyk's `~beta`, `~experimental`) are not what kit pins.
  const stable = (list as string[]).filter((v) => !v.includes("~")).sort();
  const supported = list.includes(source.pinned);
  return {
    version: stable[stable.length - 1],
    dead: supported ? [] : [`pinned API version ${source.pinned} is no longer listed as supported`],
    notes: supported ? [`kit sends ${source.pinned}, still supported`] : [],
  };
};

const observeOpenapiPaths: Observer<"openapi-paths"> = async (source, fetchJson) => {
  const spec = (await fetchJson(source.url)) as { paths?: Record<string, unknown> };
  if (!spec.paths) throw new Error(`${source.url} has no paths`);
  const published = new Set(Object.keys(spec.paths).map(normalizePath));
  const dead: string[] = [];
  const notes: string[] = [];
  for (const path of source.paths.filter((p) => !published.has(normalizePath(p)))) {
    const why = source.acknowledged?.[path];
    if (why) notes.push(`${path} absent from the spec (acknowledged: ${why})`);
    else dead.push(`${path} is absent from the vendor's published spec`);
  }
  // No version: a spec's info.version is not a release (Vercel's reads 0.0.1).
  return { dead, notes };
};

/**
 * Observe one upstream. Every URL is checked against WATCH_HOSTS before it is fetched, and a
 * version string a registry returns must look like a version before it is reported or written
 * to the baseline; anything else is a failed lookup, never a value.
 */
export async function observe(source: Source, fetchJson: FetchJson): Promise<Observation> {
  assertSafeSource(source);
  const guarded: FetchJson = (url) => {
    assertWatchedUrl(url);
    return fetchJson(url);
  };
  const observation = await observeKind(source, guarded);
  if (observation.version !== undefined && !SAFE_VERSION.test(observation.version)) {
    throw new Error(
      `refusing malformed version ${JSON.stringify(observation.version.slice(0, 80))}`,
    );
  }
  return observation;
}

function observeKind(source: Source, fetchJson: FetchJson): Promise<Observation> {
  switch (source.kind) {
    case "npm":
      return observeNpm(source, fetchJson);
    case "pypi":
      return observePypi(source, fetchJson);
    case "github-release":
      return observeGithubRelease(source, fetchJson);
    case "api-versions":
      return observeApiVersions(source, fetchJson);
    case "openapi-paths":
      return observeOpenapiPaths(source, fetchJson);
    case "none":
      return Promise.resolve({ dead: [], notes: [source.reason] });
  }
}

/** What kit's own pin says next to what upstream has now. */
function pinNotes(entry: WatchEntry, observed: Observation): string[] {
  if (entry.pinned === "latest") return ["kit pins this to `latest`, i.e. unpinned"];
  if (entry.pinned && observed.version && versionsDiffer(entry.pinned, observed.version)) {
    return [`kit pins ${entry.pinned}`];
  }
  return [];
}

/** Classify one entry. `observed` is null when the lookup threw. */
export function evaluate(
  entry: WatchEntry,
  observed: Observation | null,
  error?: string,
): WatchResult {
  const base = { id: entry.id, owner: entry.owner };
  if (entry.source.kind === "none") {
    return { ...base, state: "not-watchable", detail: entry.source.reason };
  }
  if (!observed) return { ...base, state: "lookup-failed", detail: error ?? "lookup failed" };

  const extras = [...observed.notes, ...pinNotes(entry, observed)];
  const tail = extras.length ? ` — ${extras.join("; ")}` : "";

  if (observed.dead.length) {
    return { ...base, state: "dead", detail: observed.dead.join("; ") + tail, observed };
  }
  if (!entry.baseline) {
    const now = observed.version ? `now ${observed.version}` : "no baseline yet";
    return { ...base, state: "unobserved", detail: now + tail, observed };
  }
  const was = entry.baseline.version;
  if (was && observed.version && versionsDiffer(was, observed.version, entry.track)) {
    return {
      ...base,
      state: "changed",
      detail: `${was} → ${observed.version} since ${entry.baseline.observedAt}${tail}`,
      observed,
    };
  }
  return {
    ...base,
    state: "unchanged",
    detail: (observed.version ?? "paths present") + tail,
    observed,
  };
}

const ORDER: WatchState[] = [
  "dead",
  "lookup-failed",
  "changed",
  "unobserved",
  "not-watchable",
  "unchanged",
];

/** Anything a person should look at: everything except unchanged and declared not-watchable. */
export function needsAttention(results: WatchResult[]): WatchResult[] {
  return results.filter((r) => r.state !== "unchanged" && r.state !== "not-watchable");
}

export function renderReport(results: WatchResult[], date: string): string {
  const sorted = [...results].sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.id.localeCompare(b.id),
  );
  // Details carry registry text (a deprecation message, say) into a GitHub issue: escape the
  // table syntax, drop control characters, and cap the length.
  const cell = (s: string) =>
    s
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .slice(0, 400);
  const rows = sorted.map(
    (r) => `| \`${r.id}\` | **${r.state}** | ${cell(r.detail)} | \`${r.owner}\` |`,
  );
  const counts = ORDER.map((s) => `${results.filter((r) => r.state === s).length} ${s}`).join(
    " · ",
  );
  return [
    `## Upstream watch — ${date}`,
    "",
    counts,
    "",
    "| upstream | state | detail | kit pins/calls it in |",
    "|---|---|---|---|",
    ...rows,
    "",
    "`dead`: gone, deprecated, or no longer accepts what kit sends. `changed`: a new release",
    "since the baseline, which needs a look. `unobserved`: no baseline yet. Accept a reviewed",
    "state with `node scripts/upstream-watch.mjs --write-baseline` in a PR.",
    "",
  ].join("\n");
}
