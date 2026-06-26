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

/**
 * Default semgrep ruleset. `p/<pack>` packs are FETCHED from the semgrep registry
 * on first run (network), so this is NOT an offline config — only a local ruleset
 * path supplied via KIT_SEMGREP_CONFIG runs air-gapped.
 */
export const DEFAULT_SEMGREP_CONFIG = "p/default";

/** Noise dirs/globs excluded from semgrep scans (vendored code, build output, tests). */
export const SEMGREP_EXCLUDES = [
  "node_modules",
  "dist",
  ".next",
  ".git",
  "coverage",
  "test",
  "tests",
  "e2e",
  "__mocks__",
  "fixtures",
  "*.test.*",
  "*.spec.*",
];

/**
 * Resolve the semgrep config: KIT_SEMGREP_CONFIG (trimmed) if set, else p/default.
 * A local ruleset path here is the only way to run semgrep with no network.
 */
export function semgrepConfig(env?: Record<string, string | undefined>): string {
  return env?.KIT_SEMGREP_CONFIG?.trim() || DEFAULT_SEMGREP_CONFIG;
}

/**
 * True when a semgrep config points at a LOCAL filesystem ruleset (runs with no
 * network). The registry forms FETCH rules from semgrep.dev (egress) and are NOT
 * local: `p/<pack>` (rule packs), `r/<rule>` (single registry rules), and `auto`
 * (which also forces telemetry). Anything else (a relative or absolute path) is a
 * local ruleset. This is the air-gap gate for semgrep — only a local config may
 * run air-gapped. Pure.
 */
export function isLocalSemgrepConfig(config: string): boolean {
  const c = config.trim();
  if (!c || c === "auto") return false;
  if (/^[pr]\//.test(c)) return false; // p/<pack>, r/<rule> — registry fetch = egress
  return true;
}

/**
 * Build semgrep CLI args with privacy + noise hardening:
 *   - explicit `--config <config>` (never `auto`, which forces telemetry on),
 *   - `--metrics off` so nothing is reported to the registry,
 *   - `--exclude` of common vendored/build/test noise.
 * sarif mode emits SARIF and scans `.`; json mode emits JSON without rewriting
 * rule ids and relies on the caller's positional target.
 */
export function buildSemgrepArgs(opts: { mode: "sarif" | "json"; config: string }): string[] {
  const args = ["scan", "--config", opts.config, "--metrics", "off", "--quiet"];
  if (opts.mode === "sarif") {
    args.push("--sarif");
  } else {
    args.push("--json", "--no-rewrite-rule-ids");
  }
  for (const glob of SEMGREP_EXCLUDES) {
    args.push("--exclude", glob);
  }
  if (opts.mode === "sarif") {
    args.push(".");
  }
  return args;
}

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
    // Opt-in SAST. A networked, multi-second semgrep scan should NOT run by
    // default (it surprised users + dominated `kit ci` time), so it is gated on
    // KIT_SEMGREP_CONFIG via needsToken: set it to a ruleset to enable. When set,
    // we run that explicit config with `--metrics off` → no telemetry (unlike
    // `--config auto`, which forces metrics on and phones the registry). `p/`
    // packs still FETCH rules from the registry on first run, so this stays
    // cloudOnly (dropped in air-gap); a LOCAL ruleset path in KIT_SEMGREP_CONFIG
    // is the only way to run semgrep air-gapped.
    id: "semgrep",
    bin: "semgrep",
    args: buildSemgrepArgs({ mode: "sarif", config: semgrepConfig(process.env) }),
    format: "sarif",
    cloudOnly: true,
    needsToken: "KIT_SEMGREP_CONFIG",
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
 *
 * semgrep is the one exception to the blanket `cloudOnly` drop: it is cloudOnly
 * because `p/<pack>`, `r/<rule>` and `auto` configs FETCH rules from the registry
 * (egress), but a LOCAL ruleset path runs fully offline. So when air-gapped, kept
 * ONLY if KIT_SEMGREP_CONFIG (via `env`) is a local path; a registry config gets
 * dropped (it would egress).
 */
export function airGapScanners(
  defs: ScannerDef[],
  enabled: boolean,
  env: Record<string, string | undefined> = process.env,
): AirGapPlan {
  if (!enabled) return { scanners: defs, env: {}, dropped: [] };
  const scanners: ScannerDef[] = [];
  const injectEnv: Record<string, string> = {};
  const dropped: string[] = [];
  for (const d of defs) {
    if (d.id === "semgrep") {
      const cfg = semgrepConfig(env);
      if (isLocalSemgrepConfig(cfg)) {
        // Local ruleset → safe to run air-gapped; rebuild args against that config.
        scanners.push({ ...d, args: buildSemgrepArgs({ mode: "sarif", config: cfg }) });
      } else {
        dropped.push(d.id);
      }
      continue;
    }
    if (d.cloudOnly) {
      dropped.push(d.id);
      continue;
    }
    if (d.offline?.env) Object.assign(injectEnv, d.offline.env);
    const extra = d.offline?.args ?? [];
    scanners.push(extra.length ? { ...d, args: [...d.args, ...extra] } : d);
  }
  return { scanners, env: injectEnv, dropped };
}

export interface AirGapVerifyRow {
  id: string;
  ok: boolean;
  detail: string;
}
export interface AirGapVerifyReport {
  ok: boolean;
  rows: AirGapVerifyRow[];
}

/**
 * Prove that every scanner that WOULD run in air-gap mode resolves to a LOCAL
 * artifact — no `cloudOnly` scanner and no registry/`auto` semgrep config (both
 * would egress). The caller passes the post-`airGapScanners` plan plus the
 * resolved semgrep config; this RE-CHECKS each remaining scanner rather than
 * trusting the drop, so a cloud/registry scanner that slipped through is named +
 * fails. Read-only, pure + deterministic.
 */
export function verifyAirGapScanners(
  scanners: ScannerDef[],
  opts: { semgrepConfig?: string } = {},
): AirGapVerifyReport {
  const rows: AirGapVerifyRow[] = [];
  for (const s of scanners) {
    if (s.id === "semgrep") {
      const cfg = (opts.semgrepConfig ?? "").trim();
      rows.push(
        isLocalSemgrepConfig(cfg)
          ? { id: s.id, ok: true, detail: `local ruleset ${cfg} (no registry fetch)` }
          : {
              id: s.id,
              ok: false,
              detail: `registry config '${cfg || DEFAULT_SEMGREP_CONFIG}' would fetch rules from the registry (egress)`,
            },
      );
      continue;
    }
    if (s.cloudOnly) {
      rows.push({
        id: s.id,
        ok: false,
        detail: "cloud-only scanner (needs a hosted backend) — must be dropped in air-gap",
      });
      continue;
    }
    rows.push({ id: s.id, ok: true, detail: "local scanner (offline DB)" });
  }
  return { ok: rows.every((r) => r.ok), rows };
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

/**
 * Statuses that mean the scanner did NOT actually execute a scan, so its verdict
 * is unknown (a green result hides the gap). `ran` succeeded; `not-applicable` is
 * a legitimate skip (the scanner does not apply to this project) and is NOT a gap.
 */
export const NON_RUNNING_STATUSES: ScannerStatus[] = ["not-installed", "no-token", "error"];

export interface ScanGateOptions {
  /** Scanner ids that MUST run; if one did not, the gate fails (even without strict). */
  requiredScanners?: string[];
  /** Strict: ANY non-running scanner fails the gate (opt-in via --strict / KIT_CI_STRICT). */
  strict?: boolean;
}

export interface ScanGate {
  ok: boolean;
  /** Hard-fail reasons — each names WHICH scanner did not run and why. */
  failures: string[];
  /** Non-fatal: a scanner did not run but is not required and strict is off. */
  warnings: string[];
}

/**
 * Reduce scanner-run HEALTH (did each scanner actually run?) to an exit verdict —
 * separate from, and combined with, the findings gate. The honest default is
 * fail-open-but-loud: a scanner that did not run is a WARN, so existing green CIs
 * keep passing (backward-compatible). Opt in to a hard fail two ways: list the
 * scanner under `requiredScanners` (that one must run), or set `strict` (ANY
 * non-running scanner fails). A required scanner that is absent from the run set
 * entirely (e.g. dropped in air-gap, not in the registry) also fails. Pure +
 * deterministic.
 */
export function scanHealthGate(runs: ScannerRun[], opts: ScanGateOptions = {}): ScanGate {
  const required = new Set(opts.requiredScanners ?? []);
  const failures: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    seen.add(r.id);
    if (!NON_RUNNING_STATUSES.includes(r.status)) continue; // ran or not-applicable
    const why = `${r.id} did not run (${r.status})`;
    if (required.has(r.id)) failures.push(`required scanner ${why}`);
    else if (opts.strict) failures.push(`${why} [strict]`);
    else warnings.push(why);
  }
  for (const id of required) {
    if (!seen.has(id)) failures.push(`required scanner ${id} did not run (not in scan plan)`);
  }
  return { ok: failures.length === 0, failures, warnings };
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
