/**
 * kit — slopsquat risk score (G4).
 *
 * Package hallucination / slopsquatting is a measured, persistent, model-agnostic
 * supply-chain surface: studies have found hallucinated package names across model
 * cohorts, and some names remain registrable despite registry defenses. kit's install-gate already blocks *un-triaged* installs; this
 * adds the missing piece — a DETERMINISTIC, calibrated risk SCORE from registry
 * metadata (existence + age + release count), not just a 200/404 existence check,
 * because an attacker who pre-registers a hallucinated name makes 404 → 200.
 *
 * The scorer is pure and zero-LLM; the registry parsers are pure (JSON + a fixed
 * clock in), so everything is unit-testable without a network. Only `fetchPackageMeta`
 * touches the network, and `assessPackage` fails toward caution when it can't.
 */

export type Ecosystem = "npm" | "pypi";

export interface PackageMeta {
  ecosystem: Ecosystem;
  name: string;
  /** Whether the name resolves on the registry at all. */
  exists: boolean;
  /** Days since the package was first published (null if unknown / nonexistent). */
  ageDays: number | null;
  /** Total published versions/releases (null if unknown). */
  releaseCount: number | null;
  /** Days since the most recent publish (null if unknown). */
  lastPublishDays: number | null;
  /** True when the lookup itself failed (network/parse) — score fails toward caution. */
  lookupFailed?: boolean;
}

export type SlopLevel = "low" | "medium" | "high" | "critical";

export interface SlopRisk {
  ecosystem: Ecosystem;
  name: string;
  /** 0–100, higher = more likely a hallucination/squat. */
  score: number;
  level: SlopLevel;
  /** Human-readable reasons contributing to the score (deterministic order). */
  signals: string[];
}

const DAY_MS = 86_400_000;

function levelFor(score: number): SlopLevel {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

/**
 * Score a package's slopsquat risk from its registry metadata. Pure + deterministic:
 * same metadata → same score. Higher = riskier.
 */
export function scoreSlopsquatRisk(meta: PackageMeta): SlopRisk {
  const signals: string[] = [];
  let score = 0;

  if (!meta.exists) {
    // The prime slopsquat signal: an LLM proposed a name that isn't registered —
    // an attacker can register it and own every future `install <name>`.
    score += 80;
    signals.push("nonexistent — hallucinated name an attacker could register");
  } else if (meta.lookupFailed) {
    // Couldn't confirm the metadata — fail toward caution rather than green.
    score += 45;
    signals.push("registry metadata unavailable — could not verify");
  } else {
    if (meta.ageDays != null) {
      if (meta.ageDays < 7) {
        score += 50;
        signals.push("registered <7 days ago");
      } else if (meta.ageDays < 30) {
        score += 35;
        signals.push("registered <30 days ago");
      } else if (meta.ageDays < 90) {
        score += 15;
        signals.push("registered <90 days ago");
      }
    } else {
      score += 20;
      signals.push("publish date unknown");
    }

    if (meta.releaseCount != null && meta.releaseCount <= 1) {
      score += 25;
      signals.push("only one published release");
    }
  }

  score = Math.min(100, score);
  return { ecosystem: meta.ecosystem, name: meta.name, score, level: levelFor(score), signals };
}

/** Parse an npm registry document (registry.npmjs.org/<name>) into PackageMeta. Pure. */
export function parseNpmRegistry(name: string, json: unknown, nowMs: number): PackageMeta {
  const doc = (json ?? {}) as {
    time?: Record<string, string>;
    versions?: Record<string, unknown>;
  };
  const time = doc.time ?? {};
  const created = time.created ? Date.parse(time.created) : NaN;
  const modified = time.modified ? Date.parse(time.modified) : NaN;
  const releaseCount = doc.versions ? Object.keys(doc.versions).length : null;
  return {
    ecosystem: "npm",
    name,
    exists: true,
    ageDays: Number.isNaN(created) ? null : Math.max(0, Math.floor((nowMs - created) / DAY_MS)),
    lastPublishDays: Number.isNaN(modified)
      ? null
      : Math.max(0, Math.floor((nowMs - modified) / DAY_MS)),
    releaseCount,
  };
}

/** Parse a PyPI JSON document (pypi.org/pypi/<name>/json) into PackageMeta. Pure. */
export function parsePypiRegistry(name: string, json: unknown, nowMs: number): PackageMeta {
  const doc = (json ?? {}) as {
    releases?: Record<string, { upload_time_iso_8601?: string }[]>;
  };
  const releases = doc.releases;
  const versions = releases ? Object.keys(releases) : null;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const files of Object.values(releases ?? {})) {
    for (const f of files ?? []) {
      const t = f.upload_time_iso_8601 ? Date.parse(f.upload_time_iso_8601) : NaN;
      if (!Number.isNaN(t)) {
        if (t < earliest) earliest = t;
        if (t > latest) latest = t;
      }
    }
  }
  return {
    ecosystem: "pypi",
    name,
    exists: true,
    ageDays: Number.isFinite(earliest)
      ? Math.max(0, Math.floor((nowMs - earliest) / DAY_MS))
      : null,
    lastPublishDays: Number.isFinite(latest)
      ? Math.max(0, Math.floor((nowMs - latest) / DAY_MS))
      : null,
    releaseCount: versions ? versions.length : null,
  };
}

const REGISTRY_URL: Record<Ecosystem, (name: string) => string> = {
  npm: (name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  pypi: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
};

/**
 * Fetch registry metadata for a package. Best-effort: a 404 → `exists:false`
 * (the hallucination signal); a network/parse failure → `lookupFailed:true` so
 * the score fails toward caution instead of green. Never throws.
 */
export async function fetchPackageMeta(
  ecosystem: Ecosystem,
  name: string,
  opts: { timeoutMs?: number; nowMs?: number } = {},
): Promise<PackageMeta> {
  const nowMs = opts.nowMs ?? Date.now();
  const url = REGISTRY_URL[ecosystem](name);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      redirect: "follow",
      headers: { accept: "application/json" },
    });
    if (res.status === 404) {
      return {
        ecosystem,
        name,
        exists: false,
        ageDays: null,
        releaseCount: null,
        lastPublishDays: null,
      };
    }
    if (!res.ok) {
      return {
        ecosystem,
        name,
        exists: true,
        ageDays: null,
        releaseCount: null,
        lastPublishDays: null,
        lookupFailed: true,
      };
    }
    const json = (await res.json()) as unknown;
    return ecosystem === "npm"
      ? parseNpmRegistry(name, json, nowMs)
      : parsePypiRegistry(name, json, nowMs);
  } catch {
    return {
      ecosystem,
      name,
      exists: true,
      ageDays: null,
      releaseCount: null,
      lastPublishDays: null,
      lookupFailed: true,
    };
  }
}

/**
 * Assess a single package: fetch its metadata then score it. The fetcher is
 * injectable so callers (and tests) can supply canned metadata without a network.
 */
export async function assessPackage(
  ecosystem: Ecosystem,
  name: string,
  opts: { fetchMeta?: (e: Ecosystem, n: string) => Promise<PackageMeta>; nowMs?: number } = {},
): Promise<SlopRisk> {
  const fetchMeta = opts.fetchMeta ?? ((e, n) => fetchPackageMeta(e, n, { nowMs: opts.nowMs }));
  const meta = await fetchMeta(ecosystem, name);
  return scoreSlopsquatRisk(meta);
}
