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
}

export const SCANNERS: ScannerDef[] = [
  { id: "snyk", bin: "snyk", args: ["test", "--sarif"], format: "sarif", needsToken: "SNYK_TOKEN" },
  { id: "trivy", bin: "trivy", args: ["fs", "--format", "sarif", "--quiet", "."], format: "sarif" },
  { id: "grype", bin: "grype", args: ["dir:.", "-o", "sarif", "-q"], format: "sarif" },
  {
    id: "semgrep",
    bin: "semgrep",
    args: ["scan", "--sarif", "--quiet", "--config", "auto", "."],
    format: "sarif",
  },
  { id: "osv-scanner", bin: "osv-scanner", args: ["--format", "json", "-r", "."], format: "osv" },
];

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
