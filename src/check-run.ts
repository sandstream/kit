/**
 * kit check — the collection core shared by `kit check` (CLI), the MCP `kit_check`
 * tool, and `kit review`'s check stage (review-run.ts). The verdict rule already
 * lives in one place (check-verdict.ts); this hoists the other half — WHICH checks
 * run, in what order, with which baseline handling — so the surfaces can't drift
 * apart on collection either (same parity discipline as standards-run.ts).
 *
 * Pure collection: no printing, no auto-install/self-heal, no PAL sync,
 * no attestation — those are `kit check`'s own CLI extras and stay in
 * commands/check.ts. Callers with a progress UI pass `step` to wrap each
 * dimension (the CLI's spinner); everyone else gets a plain run.
 */
import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import { KIT_FILE } from "./cli-shared.js";
import { checkTools, type ToolStatus } from "./check-tools.js";
import { checkServices, type ServiceStatus } from "./check-services.js";
import { checkSecrets, type SecretStatus } from "./check-secrets.js";
import { checkSkills, type SkillCheckResult } from "./check-skills.js";
import { checkHooks, isGitRepository, type HookCheckResult } from "./check-hooks.js";
import { checkWebSearch, type WebSearchStatus } from "./check-web-search.js";
import { checkSecurity, type SecurityCheckResult, type GateOpts } from "./check-security.js";
import { checkLockFiles, type LockCheckResult } from "./check-lock.js";
import { checkTests, type TestCheckResult } from "./check-tests.js";
import { checkDeploy, type DeployCheckResult } from "./check-deploy.js";
import { loadBaselineForGate, baselineGet, BASELINE_FILE } from "./baseline.js";
import { computeCheckVerdict, type CheckVerdict } from "./check-verdict.js";
import type { JsonCheck } from "./cli-checks-shared.js";

export interface CheckRunResult {
  ok: boolean;
  verdict: CheckVerdict;
  tools: ToolStatus[];
  services: ServiceStatus[];
  secrets: { templateExists: boolean | null; keys: SecretStatus[] };
  skills: SkillCheckResult[];
  hooks: HookCheckResult[];
  webSearch: WebSearchStatus | null;
  deploy: DeployCheckResult[];
  security: SecurityCheckResult[];
  tests: TestCheckResult[];
  locks: LockCheckResult[];
  /**
   * Non-null when the run was narrowed with `--category`: the dimensions that were
   * actually run. `ok` is then a verdict over THOSE ONLY — every consumer that
   * reports a verdict must say so, or a partial green reads as a full one.
   */
  scope: CheckCategory[] | null;
}

/**
 * The dimensions `runCheckGate` can run, and the accepted values of
 * `kit check --category`. `security` was documented (and shipped in kit's own
 * generated CLAUDE.md, in example pre-commit hooks, and in a CI workflow) long
 * before anything parsed it — the flag was read by no one and the full check ran.
 */
export const CHECK_CATEGORIES = [
  "tools",
  "services",
  "secrets",
  "skills",
  "hooks",
  "web",
  "deploy",
  "security",
  "locks",
  "tests",
] as const;

export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export function isCheckCategory(value: string): value is CheckCategory {
  return (CHECK_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Parse a `--category` value into dimensions. Accepts a comma-separated list.
 *
 * Returns `{ categories }` on success, or `{ invalid }` naming every unrecognised
 * value — the caller reports and exits. An unrecognised category must never fall
 * back to a full run: that is exactly the silent no-op this flag used to be.
 * `undefined` in (flag absent) means a full run, expressed as `categories:
 * undefined`.
 */
export function parseCategoryFlag(
  raw: string | undefined,
):
  | { categories: CheckCategory[] | undefined; invalid?: undefined }
  | { categories?: undefined; invalid: string[] } {
  if (raw === undefined) return { categories: undefined };
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) return { invalid: ["(empty)"] };
  const invalid = requested.filter((r) => !isCheckCategory(r));
  if (invalid.length > 0) return { invalid };
  return { categories: requested as CheckCategory[] };
}

export interface RunCheckOptions {
  cwd?: string;
  /** Preloaded config (the CLI already has one for governance); else loaded from cwd. */
  config?: kitConfig;
  /** Fail (not warn) on untested files — the CLI's --enforce-tests. */
  enforceTests?: boolean;
  /** Security gate posture (lenient / fail-on-warning) for the verdict. */
  gate?: GateOpts;
  /** Progress hook — the CLI wraps each dimension in a spinner; default runs plain. */
  step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Run only these dimensions. Undefined/empty = all of them.
   *
   * A narrowed run reports a verdict over what it ACTUALLY ran, and sets
   * `scope` on the result so no consumer can read a partial green as a full one.
   * Omitted dimensions are absent, never synthesised as passes.
   */
  categories?: readonly CheckCategory[];
}

export async function runCheckGate(opts: RunCheckOptions = {}): Promise<CheckRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const config = opts.config ?? (await loadConfig(resolve(cwd, KIT_FILE)));
  const step = opts.step ?? (<T>(_label: string, fn: () => Promise<T>): Promise<T> => fn());

  // Narrowing predicate. An empty/absent list means "everything", so the default
  // path is unchanged and cannot be narrowed by accident.
  const selected = opts.categories && opts.categories.length > 0 ? opts.categories : null;
  const wants = (dim: CheckCategory): boolean => selected === null || selected.includes(dim);
  const scope: CheckCategory[] | null = selected ? [...selected] : null;

  const tools =
    wants("tools") && config.tools ? await step("tools", () => checkTools(config.tools!)) : [];
  const services =
    wants("services") && config.services
      ? await step("services", () => checkServices(config.services!))
      : [];
  const secrets =
    wants("secrets") && config.secrets
      ? await step("secrets", () => checkSecrets(config.secrets!, cwd))
      : { templateExists: null, keys: [] };
  const skills =
    wants("skills") && config.skills ? await step("skills", () => checkSkills(config.skills!)) : [];
  const hooks =
    wants("hooks") && config.hooks && isGitRepository(".git", cwd)
      ? await step("git hooks", () => checkHooks(config.hooks!, ".git", cwd))
      : [];
  const webSearch =
    wants("web") && config.web?.search
      ? await step("web search", () => checkWebSearch(config.web!.search!))
      : null;
  const deploy = wants("deploy")
    ? await step("deploy config", () => checkDeploy(config.deploy, cwd))
    : [];
  const security = wants("security") ? await step("security scan", () => checkSecurity(cwd)) : [];
  const locks = wants("locks") ? await step("lock files", () => checkLockFiles(config, cwd)) : [];

  // Test-coverage is part of the verdict on every surface (omitting it on one
  // was half of the historical CLI-vs-MCP divergence). Baseline-aware; a
  // corrupt/tampered baseline is ignored (nothing suppressed) and surfaced as a
  // finding — fail-closed + visible, never a crash of the gate.
  const { baseline, ignored: baselineIgnored } = await loadBaselineForGate(cwd);
  if (baselineIgnored && wants("security")) {
    security.push({
      category: "secrets",
      name: "baseline integrity",
      status: "warn",
      severity: "low",
      detail: `${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings; re-freeze with 'kit baseline freeze'`,
    });
  }
  const tests = wants("tests")
    ? await step("test coverage", () =>
        checkTests({
          // `checkTests` already accepted a `cwd` and defaulted it to `process.cwd()`; this call
          // simply never passed one, so the coverage dimension measured the calling process's
          // tree while every other dimension was being fixed to measure the governed one.
          cwd,
          enforce: opts.enforceTests,
          baseline: baselineGet(baseline, "tests", "untested_files"),
        }),
      )
    : [];

  const verdict = computeCheckVerdict(
    {
      tools,
      services,
      secrets: secrets.keys,
      skills,
      hooks,
      deploy,
      security,
      tests,
      locks,
    },
    opts.gate ?? {},
  );

  return {
    ok: verdict.ok,
    verdict,
    tools,
    services,
    secrets,
    skills,
    hooks,
    webSearch,
    deploy,
    security,
    tests,
    locks,
    scope,
  };
}

/**
 * Flatten a check run into the machine-readable rows `kit check --json` emits
 * and `kit review`'s check stage reports — one mapping, so the row shape can't
 * fork between surfaces.
 */
export function checkRunToJsonChecks(r: CheckRunResult): JsonCheck[] {
  return [
    ...r.tools.map((t) => ({
      name: t.name,
      status: (t.ok ? "pass" : "fail") as JsonCheck["status"],
      detail: t.installed ? `installed ${t.installed}` : "not installed",
      category: "tools",
    })),
    ...r.services.map((s) => ({
      name: s.name,
      status: (s.authenticated ? "pass" : s.informational ? "warn" : "fail") as JsonCheck["status"],
      detail: s.informational
        ? s.output || "manual setup (no CLI login)"
        : (s.output ?? (s.authenticated ? "authenticated" : "not authenticated")),
      category: "services",
    })),
    ...r.secrets.keys.map((s) => ({
      name: s.name,
      status: (s.unverified ? "warn" : s.available ? "pass" : "fail") as JsonCheck["status"],
      detail: s.detail ?? (s.available ? "available" : "missing"),
      category: "secrets",
    })),
    ...r.skills.map((s) => ({
      name: s.name,
      status: (s.installed ? "pass" : s.required ? "fail" : "warn") as JsonCheck["status"],
      detail: s.installed ? "installed" : "not installed",
      category: "skills",
    })),
    ...r.hooks.map((h) => ({
      name: h.hookName,
      status: (!h.installed ? "fail" : !h.upToDate ? "warn" : "pass") as JsonCheck["status"],
      detail: h.detail,
      category: "hooks",
    })),
    ...(r.webSearch
      ? [
          {
            name: r.webSearch.provider,
            status: (r.webSearch.healthy ? "pass" : "fail") as JsonCheck["status"],
            detail: r.webSearch.error ?? (r.webSearch.healthy ? "healthy" : "unhealthy"),
            category: "web-search",
          },
        ]
      : []),
    ...r.deploy.map((d) => ({
      name: d.provider === "deploy" ? "deploy" : `${d.provider}/${d.environment}/${d.project}`,
      status: d.status as JsonCheck["status"],
      detail: d.detail,
      category: "deploy",
      ...(d.didNotRun ? { didNotRun: true as const } : {}),
    })),
    ...r.locks.map((l) => ({
      name: l.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json",
      status: (l.inSync ? "pass" : l.exists ? "warn" : "fail") as JsonCheck["status"],
      detail: l.detail,
      category: "lock",
    })),
    // `severity` and `didNotRun` are carried through deliberately: JsonCheck has always
    // declared severity and this projection silently dropped it, and didNotRun is what lets
    // a consumer tell "stopped failing" from "stopped looking" (see scan-diff.ts).
    ...r.security.map((s) => ({
      name: s.name,
      status: s.status,
      detail: s.detail,
      category: `security/${s.category}`,
      ...(s.severity ? { severity: s.severity } : {}),
      ...(s.didNotRun ? { didNotRun: true as const } : {}),
    })),
    ...r.tests.map((t) => ({
      name: t.name,
      status: t.status,
      detail: t.detail,
      category: "tests",
    })),
  ];
}
