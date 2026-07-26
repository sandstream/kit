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
  security: SecurityCheckResult[];
  tests: TestCheckResult[];
  locks: LockCheckResult[];
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
}

export async function runCheckGate(opts: RunCheckOptions = {}): Promise<CheckRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const config = opts.config ?? (await loadConfig(resolve(cwd, KIT_FILE)));
  const step = opts.step ?? (<T>(_label: string, fn: () => Promise<T>): Promise<T> => fn());

  const tools = config.tools ? await step("tools", () => checkTools(config.tools!)) : [];
  const services = config.services
    ? await step("services", () => checkServices(config.services!))
    : [];
  const secrets = config.secrets
    ? await step("secrets", () => checkSecrets(config.secrets!))
    : { templateExists: null, keys: [] };
  const skills = config.skills ? await step("skills", () => checkSkills(config.skills!)) : [];
  const hooks =
    config.hooks && isGitRepository() ? await step("git hooks", () => checkHooks(config.hooks!)) : [];
  const webSearch = config.web?.search
    ? await step("web search", () => checkWebSearch(config.web!.search!))
    : null;
  const security = await step("security scan", () => checkSecurity());
  const locks = await step("lock files", () => checkLockFiles(config));

  // Test-coverage is part of the verdict on every surface (omitting it on one
  // was half of the historical CLI-vs-MCP divergence). Baseline-aware; a
  // corrupt/tampered baseline is ignored (nothing suppressed) and surfaced as a
  // finding — fail-closed + visible, never a crash of the gate.
  const { baseline, ignored: baselineIgnored } = await loadBaselineForGate();
  if (baselineIgnored) {
    security.push({
      category: "secrets",
      name: "baseline integrity",
      status: "warn",
      severity: "low",
      detail: `${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings; re-freeze with 'kit baseline freeze'`,
    });
  }
  const tests = await step("test coverage", () =>
    checkTests({
      enforce: opts.enforceTests,
      baseline: baselineGet(baseline, "tests", "untested_files"),
    }),
  );

  const verdict = computeCheckVerdict(
    {
      tools,
      services,
      secrets: secrets.keys,
      skills,
      hooks,
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
    security,
    tests,
    locks,
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
    ...r.locks.map((l) => ({
      name: l.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json",
      status: (l.inSync ? "pass" : l.exists ? "warn" : "fail") as JsonCheck["status"],
      detail: l.detail,
      category: "lock",
    })),
    ...r.security.map((s) => ({
      name: s.name,
      status: s.status,
      detail: s.detail,
      category: `security/${s.category}`,
    })),
    ...r.tests.map((t) => ({
      name: t.name,
      status: t.status,
      detail: t.detail,
      category: "tests",
    })),
  ];
}
