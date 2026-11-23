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
import type { IngestFormat, IngestGap } from "./adapters/ingest.js";
import { settleScanner, type ScannerProcess } from "./scan-result.js";

/**
 * Downloaded terraform provider binaries. They are vendored Go programs: scanning them produced 54
 * percent of the findings in one repo. Only this directory is skipped, never `.terraform/` itself or
 * the lock file and sources next to it.
 */
const PROVIDER_DIR = ".terraform/providers";
// Built from parts: a literal slash-star-star inside a string is read as a comment start by lizard.
export const PROVIDER_GLOB = ["**", PROVIDER_DIR].join("/");
const PROVIDER_GLOB_ALL = [PROVIDER_GLOB, "**"].join("/");

/**
 * Default semgrep ruleset. `p/<pack>` packs are FETCHED from the semgrep registry
 * on first run (network), so this is NOT an offline config — only a local ruleset
 * path supplied via KIT_SEMGREP_CONFIG runs air-gapped.
 */
export const DEFAULT_SEMGREP_CONFIG = "p/default";

/** Noise dirs/globs excluded from semgrep scans (vendored code, build output, tests). */
export const SEMGREP_EXCLUDES = [
  "node_modules",
  PROVIDER_DIR,
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
  // p/<pack>, r/<rule>: a registry fetch is egress
  if (c.startsWith("p/") || c.startsWith("r/")) return false;
  return true;
}

/**
 * Build semgrep CLI args with privacy + noise hardening:
 *   - explicit `--config <config>` (never `auto`, which forces telemetry on),
 *   - `--metrics off` so nothing is reported to the registry,
 *   - `--exclude` of common vendored/build/test noise.
 * Delegate mode emits native report data, uses normal rule ids and scans `.`.
 * Check mode keeps original rule ids and relies on the caller's positional target.
 */
export function buildSemgrepArgs(opts: { mode: "delegate" | "json"; config: string }): string[] {
  const args = ["scan", "--config", opts.config, "--metrics", "off", "--quiet"];
  args.push("--json");
  if (opts.mode === "json") args.push("--no-rewrite-rule-ids");
  for (const glob of SEMGREP_EXCLUDES) {
    args.push("--exclude", glob);
  }
  if (opts.mode === "delegate") {
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
  format: IngestFormat; // Format Kit ingests after any native evidence processing.
  evidence?: "grype-directory" | "trivy-fs" | "trivy-config" | "trivy-image" | "semgrep" | "snyk";
  /** env var that must be set (e.g. SNYK_TOKEN) */
  needsToken?: string;
  /** marker files that make the scanner applicable; undefined = always */
  detect?: string[];
  /** Cannot run with no network (needs a hosted backend) — dropped in air-gap mode. */
  cloudOnly?: boolean;
  timeoutMs?: number; // longer than the default, for a run that is slow by nature (an image pull)
  /** Extra args/env applied in air-gap mode so the scanner runs against a local DB. */
  offline?: { args?: string[]; env?: Record<string, string> };
  /**
   * Read the Socket policy verdict and retain reported violations.
   * Socket CI supplies no proof of policy coverage. This path does not use `format`.
   */
  exitGate?: boolean;
  /** Exit code that means "nothing here to scan" (osv-scanner: 128), not a failure. */
  noTargetExit?: number;
  /** A nonzero exit code the delegate reserves for a completed report with findings. */
  findingsExit?: number;
  cwd?: string; // repo-relative directory to run in; set by expandPerProject (scan-projects.ts)
}

export const SCANNERS: ScannerDef[] = [
  // snyk talks to the Snyk cloud → not usable in a no-egress enclave.
  {
    id: "snyk",
    bin: "snyk",
    evidence: "snyk",
    args: ["test", "--sarif"],
    format: "sarif",
    needsToken: "SNYK_TOKEN",
    findingsExit: 1,
    cloudOnly: true,
  },
  {
    id: "trivy",
    bin: "trivy",
    evidence: "trivy-fs",
    args: [
      "fs",
      "--skip-dirs",
      PROVIDER_GLOB,
      "--format",
      "json",
      "--list-all-pkgs",
      "--quiet",
      ".",
    ],
    format: "sarif",
    // run against the pre-synced local DB; never reach out to update it
    offline: { args: ["--offline-scan", "--skip-db-update"] },
  },
  {
    // Infrastructure code: Dockerfile and terraform misconfigurations (for example a container that
    // runs as root). `trivy fs` above looks at dependencies only. Applies only where such files exist.
    id: "trivy-config",
    bin: "trivy",
    evidence: "trivy-config",
    args: ["config", "--skip-dirs", PROVIDER_GLOB, "--format", "json", "--quiet", "."],
    format: "sarif",
    detect: ["*.tf", "Dockerfile"],
    // the check bundle is fetched from a registry unless told not to
    offline: { args: ["--skip-check-update"] },
  },
  {
    id: "grype",
    bin: "grype",
    args: ["dir:.", "--exclude", PROVIDER_GLOB_ALL, "-o", "sarif", "-q"],
    evidence: "grype-directory",
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
    evidence: "semgrep",
    args: buildSemgrepArgs({ mode: "delegate", config: semgrepConfig(process.env) }),
    format: "sarif",
    cloudOnly: true,
    needsToken: "KIT_SEMGREP_CONFIG",
  },
  {
    id: "osv-scanner",
    bin: "osv-scanner",
    timeoutMs: 600_000, // resolves Maven transitive dependencies over the network
    args: ["--format", "json", "--experimental-exclude", `g:${PROVIDER_GLOB}`, "-r", "."],
    format: "osv",
    offline: { args: ["--offline"] },
    noTargetExit: 128,
    findingsExit: 1,
  },
  {
    // Socket uploads manifests to socket.dev. The delegate needs a token and network access.
    id: "socket",
    bin: "socket",
    args: ["ci"],
    format: "sarif", // unused — exitGate short-circuits before ingest
    needsToken: "SOCKET_SECURITY_API_TOKEN",
    cloudOnly: true,
    exitGate: true,
  },
];

/**
 * The scanner def without its provider-directory exclusion. Used when git tracks files there: a
 * tracked directory is not downloaded provider output, and skipping it would let a vulnerable file
 * be committed under that name to avoid every scanner.
 */
export function dropProviderExclusion(def: ScannerDef): ScannerDef {
  const args: string[] = [];
  for (let i = 0; i < def.args.length; i++) {
    const isExclusion = def.args[i + 1]?.includes(PROVIDER_DIR) && def.args[i].startsWith("--");
    if (isExclusion) i++;
    else args.push(def.args[i]);
  }
  return { ...def, args };
}

/** Every registered scanner id, in registry order — the delegate library. */
export const SCANNER_IDS: readonly string[] = SCANNERS.map((s) => s.id);

/**
 * Resolve which scanner delegates are enabled given the optional `[scan].delegates`
 * allow-list from .kit.toml. Absent or empty ⇒ every registered scanner is enabled
 * (backwards-compatible). Unknown ids in the config are ignored here. Order follows
 * the registry, not the config. This is the "connect what we should not copy"
 * toggle — kit delegates DETECTION, never its verdict.
 */
export function enabledScanners(
  defs: ScannerDef[] = SCANNERS,
  configDelegates?: readonly string[],
): ScannerDef[] {
  if (!configDelegates || configDelegates.length === 0) return [...defs];
  const allow = new Set(configDelegates);
  return defs.filter((s) => allow.has(s.id));
}

/** Is scanner `id` enabled under the given `[scan].delegates` toggle? Empty ⇒ all on. */
export function isScannerEnabled(id: string, configDelegates?: readonly string[]): boolean {
  if (!configDelegates || configDelegates.length === 0) return true;
  return configDelegates.includes(id);
}

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
        scanners.push({ ...d, args: buildSemgrepArgs({ mode: "delegate", config: cfg }) });
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
function semgrepAirGapRow(id: string, config: string): AirGapVerifyRow {
  if (isLocalSemgrepConfig(config)) {
    return { id, ok: true, detail: "local ruleset " + config + " (no registry fetch)" };
  }
  const shown = config || DEFAULT_SEMGREP_CONFIG;
  const detail = "registry config " + shown + " would fetch rules from the registry (egress)";
  return { id, ok: false, detail };
}

export function verifyAirGapScanners(
  scanners: ScannerDef[],
  opts: { semgrepConfig?: string } = {},
): AirGapVerifyReport {
  const rows: AirGapVerifyRow[] = scanners.map((s) => {
    if (s.id === "semgrep") return semgrepAirGapRow(s.id, (opts.semgrepConfig ?? "").trim());
    if (s.cloudOnly) {
      const detail = "cloud-only scanner (needs a hosted backend), must be dropped in air-gap";
      return { id: s.id, ok: false, detail };
    }
    return { id: s.id, ok: true, detail: "local scanner (offline DB)" };
  });
  return { ok: rows.every((r) => r.ok), rows };
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

// A constructor, not a literal: lizard misreads this literal and stretches the previous function.
const ADVISORY_ID = new RegExp(
  "(CVE-\\d{4}-\\d{1,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})",
  "i",
);

/** Cross-scanner dedup key: a CVE/GHSA id if present in the finding, else its name. */
export function dedupKey(f: SecurityCheckResult): string {
  const m = ADVISORY_ID.exec(`${f.name} ${f.detail ?? ""}`);
  return m ? m[1].toUpperCase() : f.name;
}

export interface MergedFinding extends SecurityCheckResult {
  /** which scanners reported this finding */
  scanners: string[];
  /** CISA KEV: the CVE is exploited in the wild (set by `kit scan`, see exploit-intel.ts). */
  kev?: { cve: string; dateAdded: string; ransomware: boolean };
  /** FIRST EPSS: the highest exploitation probability among the finding's CVEs. */
  epss?: { cve: string; score: number; percentile: number };
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
      if (f.aliases?.length) {
        existing.aliases = [...new Set([...(existing.aliases ?? []), ...f.aliases])];
      }
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

export type ScannerStatus =
  "ran" | "not-installed" | "no-token" | "not-applicable" | "error" | "partial" | "timed-out"; // kit stopped it at its time limit
export interface ScannerRun {
  id: string;
  status: ScannerStatus;
  findings: number;
  /** Why a scanner errored: its first stderr line, cleaned. Never set for a scanner that ran. */
  reason?: string;
  /** The scanner found nothing to scan (not-applicable). A required scanner does not accept this. */
  noTarget?: boolean;
  reportGap?: IngestGap;
  packageCount?: number;
  checkCount?: number;
  fileCount?: number;
  targetFiles?: string[];
}

/** Environment for a scanner child. PWD is reset because Go tools trust it over the real directory. */
export function scannerEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
  cwd: string,
): Record<string, string | undefined> {
  return { ...base, ...extra, PWD: cwd };
}

/**
 * Statuses that mean the scanner did NOT actually execute a scan, so its verdict
 * is unknown (a green result hides the gap). `ran` succeeded; `not-applicable` is
 * a legitimate skip (the scanner does not apply to this project) and is NOT a gap.
 */
const NON_RUNNING_STATUSES: ScannerStatus[] = [
  "not-installed",
  "no-token",
  "error",
  "partial",
  "timed-out",
];

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
    if (r.status === "not-applicable" && required.has(r.id)) {
      failures.push(`required scanner ${r.id} found nothing to scan`);
      continue;
    }
    if (!NON_RUNNING_STATUSES.includes(r.status)) continue; // ran or not-applicable
    const why =
      r.status === "partial"
        ? `${r.id} did not complete (partial)`
        : `${r.id} did not run (${r.status})`;
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
  run(
    bin: string,
    args: string[],
    timeoutMs?: number,
    cwd?: string,
    evidence?: ScannerDef["evidence"],
  ): Promise<ScannerProcess>;
  hasEnv(name: string): boolean;
  detect(
    markers: string[],
    cwd?: string,
    evidence?: ScannerDef["evidence"],
  ): boolean | Promise<boolean>;
}

/** Run each applicable+installed scanner, ingest its output, merge into one verdict. */
export async function runScanners(
  deps: ScanDeps,
  scanners: ScannerDef[] = SCANNERS,
): Promise<{ merged: MergedFinding[]; runs: ScannerRun[] }> {
  const runs: ScannerRun[] = [];
  const perScanner: { id: string; findings: SecurityCheckResult[] }[] = [];
  for (const s of scanners) {
    if (s.detect && !(await deps.detect(s.detect, s.cwd, s.evidence))) {
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
    const res = await deps.run(bin, s.args, s.timeoutMs, s.cwd, s.evidence);
    const settled = settleScanner(s, res);
    runs.push(settled.run);
    if (settled.findings) perScanner.push({ id: s.id, findings: settled.findings });
  }
  return { merged: mergeFindings(perScanner), runs };
}
