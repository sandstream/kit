/**
 * Scanner-runner registry — kit's consolidation play (#62, anchored by #50).
 *
 * A data-driven registry of external scanners that emit SARIF/OSV. `kit scan`
 * runs the applicable+installed ones, pipes each output through the #48 ingest
 * adapter, and MERGES the results locally into one deduped verdict — the same
 * CVE/GHSA reported by multiple scanners collapses to one row (max severity,
 * union of which scanners flagged it). Local-first, zero-server, deterministic.
 *
 * Pure parts (registry, dedup, merge) are fixture-tested; `runScanners` takes
 * injectable deps so the orchestration is testable without real scanners.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { ingestStrict, type IngestFormat } from "./adapters/ingest.js";

export interface ScannerDef {
  id: string;
  /** executable, resolved mise-first */
  bin: string;
  /** args that emit SARIF/OSV on stdout */
  args: string[];
  format: IngestFormat;
  /** env var that must be set (e.g. SNYK_TOKEN) */
  needsToken?: string;
  /** marker files that make the scanner applicable; undefined = always */
  detect?: string[];
  /** Cannot run with no network (needs a hosted backend) — dropped in air-gap mode. */
  cloudOnly?: boolean;
  /** Extra args/env applied in air-gap mode so the scanner runs against a local DB. */
  offline?: { args?: string[]; env?: Record<string, string> };
  /**
   * Exit-code gate: the tool has no stable findings-JSON to parse, so its own exit
   * status IS the verdict — exit 0 = clean, non-zero = one high-severity policy
   * violation. (Socket: `socket ci` uploads manifests + fails on policy; `format`
   * is unused because the exitGate branch short-circuits before ingest.)
   */
  exitGate?: boolean;
}

export const SCANNERS: ScannerDef[] = [
  // snyk talks to the Snyk cloud → not usable in a no-egress enclave.
  {
    id: "snyk",
    bin: "snyk",
    args: ["test", "--sarif"],
    format: "sarif",
    needsToken: "SNYK_TOKEN",
    cloudOnly: true,
  },
  {
    id: "trivy",
    bin: "trivy",
    args: ["fs", "--format", "sarif", "--quiet", "."],
    format: "sarif",
    // run against the pre-synced local DB; never reach out to update it
    offline: { args: ["--offline-scan", "--skip-db-update"] },
  },
  {
    id: "grype",
    bin: "grype",
    args: ["dir:.", "-o", "sarif", "-q"],
    format: "sarif",
    offline: { env: { GRYPE_DB_AUTO_UPDATE: "false" } },
  },
  {
    // `--config auto` fetches the semgrep registry; without a local ruleset it
    // can't run offline, so it's dropped in air-gap mode (point it at a local
    // ruleset via a future KIT_SEMGREP_CONFIG to re-enable — tracked).
    id: "semgrep",
    bin: "semgrep",
    args: ["scan", "--sarif", "--quiet", "--config", "auto", "."],
    format: "sarif",
    cloudOnly: true,
  },
  {
    id: "osv-scanner",
    bin: "osv-scanner",
    args: ["--format", "json", "-r", "."],
    format: "osv",
    offline: { args: ["--offline"] },
  },
  {
    // Socket uploads manifests to socket.dev (cloud) → not air-gappable. The CLI
    // has no stable findings-JSON, so kit gates on `socket ci`'s exit code rather
    // than parsing output. Opt-in: needs SOCKET_SECURITY_API_TOKEN (wired by
    // `kit setup` in connected/non-air-gap posture).
    id: "socket",
    bin: "socket",
    args: ["ci"],
    format: "sarif", // unused — exitGate short-circuits before ingest
    needsToken: "SOCKET_SECURITY_API_TOKEN",
    cloudOnly: true,
    exitGate: true,
  },
];

/** True when air-gap mode is requested via env (KIT_AIRGAP=1/true/yes). */
export function isAirGap(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes((env.KIT_AIRGAP ?? "").trim().toLowerCase());
}

export interface AirGapPlan {
  /** Scanners that can run offline, with their offline args folded in. */
  scanners: ScannerDef[];
  /** Env to inject into every scanner run (e.g. disable DB auto-update). */
  env: Record<string, string>;
  /** ids of cloud-only scanners excluded because they need network. */
  dropped: string[];
}

/**
 * Transform the registry for air-gap mode: drop `cloudOnly` scanners and fold
 * each remaining scanner's `offline` args/env in so it runs against a local DB
 * with no network. A no-op (returns the input) when `enabled` is false.
 */
export function airGapScanners(defs: ScannerDef[], enabled: boolean): AirGapPlan {
  if (!enabled) return { scanners: defs, env: {}, dropped: [] };
  const scanners: ScannerDef[] = [];
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const d of defs) {
    if (d.cloudOnly) {
      dropped.push(d.id);
      continue;
    }
    if (d.offline?.env) Object.assign(env, d.offline.env);
    const extra = d.offline?.args ?? [];
    scanners.push(extra.length ? { ...d, args: [...d.args, ...extra] } : d);
  }
  return { scanners, env, dropped };
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Cross-scanner dedup key: a CVE/GHSA id if present in the finding, else its name. */
export function dedupKey(f: SecurityCheckResult): string {
  const m = /(CVE-\d{4}-\d{1,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/i.exec(
    `${f.name} ${f.detail ?? ""}`,
  );
  return m ? m[1].toUpperCase() : f.name;
}

export interface MergedFinding extends SecurityCheckResult {
  /** which scanners reported this finding */
  scanners: string[];
}

/** Collapse findings from many scanners by dedupKey — max severity, union of scanners. */
export function mergeFindings(
  perScanner: { id: string; findings: SecurityCheckResult[] }[],
): MergedFinding[] {
  const byKey = new Map<string, MergedFinding>();
  for (const { id, findings } of perScanner) {
    for (const f of findings) {
      const key = dedupKey(f);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...f, scanners: [id] });
        continue;
      }
      if (!existing.scanners.includes(id)) existing.scanners.push(id);
      if ((RANK[f.severity ?? "low"] ?? 0) > (RANK[existing.severity ?? "low"] ?? 0)) {
        existing.severity = f.severity;
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => (RANK[b.severity ?? "low"] ?? 0) - (RANK[a.severity ?? "low"] ?? 0),
  );
}

/** Drop merged findings whose key is in the accepted baseline (#59 noise-reduction). */
export function suppressBaselined(
  merged: MergedFinding[],
  accepted: ReadonlySet<string>,
): { kept: MergedFinding[]; suppressed: number } {
  if (accepted.size === 0) return { kept: merged, suppressed: 0 };
  const kept = merged.filter((m) => !accepted.has(dedupKey(m)));
  return { kept, suppressed: merged.length - kept.length };
}

export type ScannerStatus = "ran" | "not-installed" | "no-token" | "not-applicable" | "error";
export interface ScannerRun {
  id: string;
  status: ScannerStatus;
  findings: number;
}

export interface ScanDeps {
  resolve(bin: string): Promise<string | null>;
  run(bin: string, args: string[]): Promise<{ ok: boolean; stdout: string }>;
  hasEnv(name: string): boolean;
  detect(markers: string[]): boolean;
}

/** Run each applicable+installed scanner, ingest its output, merge into one verdict. */
export async function runScanners(
  deps: ScanDeps,
  scanners: ScannerDef[] = SCANNERS,
): Promise<{ merged: MergedFinding[]; runs: ScannerRun[] }> {
  const runs: ScannerRun[] = [];
  const perScanner: { id: string; findings: SecurityCheckResult[] }[] = [];
  for (const s of scanners) {
    if (s.detect && !deps.detect(s.detect)) {
      runs.push({ id: s.id, status: "not-applicable", findings: 0 });
      continue;
    }
    const bin = await deps.resolve(s.bin);
    if (!bin) {
      runs.push({ id: s.id, status: "not-installed", findings: 0 });
      continue;
    }
    if (s.needsToken && !deps.hasEnv(s.needsToken)) {
      runs.push({ id: s.id, status: "no-token", findings: 0 });
      continue;
    }
    const res = await deps.run(bin, s.args);
    // Exit-code-gated scanners (e.g. Socket): no parseable findings — the tool's
    // own exit status IS the verdict. Never false-green on a crash: any non-zero
    // exit becomes one high-severity policy-violation finding.
    if (s.exitGate) {
      if (res.ok) {
        runs.push({ id: s.id, status: "ran", findings: 0 });
      } else {
        perScanner.push({
          id: s.id,
          findings: [
            {
              category: "supply-chain",
              name: `${s.id}: policy violation`,
              status: "fail",
              detail: `${s.id} ci exited non-zero — dependency security/license policy issues found (see the ${s.id} dashboard)`,
              severity: "high",
            },
          ],
        });
        runs.push({ id: s.id, status: "ran", findings: 1 });
      }
      continue;
    }
    // Most scanners exit non-zero WHEN findings exist, so a non-zero exit alone
    // is not an error — parse the output regardless. But a non-empty output we
    // CANNOT parse (junk, an error blob, the wrong format) must NOT be silently
    // treated as "ran clean": that lets a broken scanner hide behind a green
    // verdict. Empty output is "ran/0" only if the process also succeeded.
    if (!res.stdout) {
      runs.push({ id: s.id, status: res.ok ? "ran" : "error", findings: 0 });
      continue;
    }
    const outcome = ingestStrict(s.format, res.stdout);
    if (!outcome.ok) {
      runs.push({ id: s.id, status: "error", findings: 0 });
      continue;
    }
    perScanner.push({ id: s.id, findings: outcome.findings });
    runs.push({ id: s.id, status: "ran", findings: outcome.findings.length });
  }
  return { merged: mergeFindings(perScanner), runs };
}
