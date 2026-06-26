/**
 * Triage — Security evaluation for open source packages, Docker images, skills, and repos.
 * Wraps the Python triage script and integrates with kit's check-security system.
 */

import { access, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { triageNpmSandbox, type SandboxResult } from "./triage-sandbox.js";
import { exec } from "./utils/exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where kit looks for the triage skill at runtime. */
const TRIAGE_SKILL_DIR = resolve(homedir(), ".claude/skills/triage");
const TRIAGE_SCRIPT = resolve(TRIAGE_SKILL_DIR, "scripts/triage.py");
/** The copy kit ships in its own package (published via package.json "files"). */
const BUNDLED_TRIAGE_SKILL = resolve(__dirname, "..", "skills", "triage");

/**
 * Self-bootstrap the gate: copy the triage skill kit ships with into
 * ~/.claude/skills/triage. Copying kit's OWN bundled, provenance-published asset
 * is not a third-party install, so it does not itself need triage. Returns true
 * if the script is in place afterwards.
 */
export async function installBundledTriageSkill(
  targetDir: string = TRIAGE_SKILL_DIR,
): Promise<boolean> {
  try {
    await mkdir(dirname(targetDir), { recursive: true });
    await cp(BUNDLED_TRIAGE_SKILL, targetDir, { recursive: true });
    await access(resolve(targetDir, "scripts/triage.py"));
    return true;
  } catch {
    return false;
  }
}

export type TriageType = "docker" | "npm" | "pip" | "repo" | "skill" | "brew" | "all" | "tools";

export { triageNpmSandbox, type SandboxResult };

export interface TriageResult {
  target: string;
  type: TriageType;
  passed: boolean;
  output: string;
}

/**
 * Ensure the triage script is present. If it is missing, self-bootstrap from the
 * copy kit ships, so the watertight gate works on a fresh machine without a
 * manual "copy the triage skill" step.
 */
async function ensureTriageScript(): Promise<boolean> {
  try {
    await access(TRIAGE_SCRIPT);
    return true;
  } catch {
    return installBundledTriageSkill();
  }
}

/**
 * Decide PASS strictly from the triage script's verdict lines.
 *
 * SECURITY: the script echoes the (attacker-influenceable) target into its
 * output header, so a naive `output.includes("TRIAGE PASSED")` is FORGEABLE — a
 * target containing the literal `TRIAGE PASSED` (or an embedded newline that
 * starts such a line) would forge a pass and defeat "installs nothing
 * untriaged". We therefore:
 *   1. require an EXACT, standalone `TRIAGE PASSED` line (not a substring), and
 *   2. treat any `TRIAGE FAILED` line as authoritative — a genuine failure
 *      always prints it, so even an injected PASS line cannot override a real
 *      failure (fail-closed). Neither line present → fail-closed.
 * (The script also sanitizes the echoed target as defense-in-depth, but kit
 * must stay safe against an older, un-updated installed script too.)
 */
export function verdictPassed(output: string): boolean {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes("TRIAGE FAILED")) return false;
  return lines.includes("TRIAGE PASSED");
}

/**
 * Mirror env vars (KIT_NPM_REGISTRY, …) derived from `.kit.toml [air_gap]`, so a
 * config-declared internal mirror is honored by the triage subprocess even when
 * the operator didn't export the env var. Best-effort: never breaks triage if
 * the config can't be read. Env vars already in `process.env` still win.
 */
async function airGapMirrorEnv(): Promise<Record<string, string>> {
  try {
    const { loadConfig } = await import("./config.js");
    const { resolveAirGap, airGapTriageEnv } = await import("./airgap/config.js");
    const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml"));
    return airGapTriageEnv(resolveAirGap(cfg.air_gap, process.env));
  } catch {
    return {};
  }
}

/** Relevant fields parsed from `brew info --json=v2 <formula>`. */
export interface BrewInfo {
  name?: string;
  version?: string;
  homepage?: string;
  /** Upstream GitHub/GitLab repo, normalized, if one is resolvable. */
  repoUrl?: string;
  deprecated: boolean;
  disabled: boolean;
}

/** Homebrew formula names (incl. tap `owner/repo/name` and `@version`). Anchored so
 *  a leading `-` can't smuggle a flag into the `brew info` arg-array. */
const BREW_FORMULA_RE = /^[a-z0-9][a-z0-9@/+._-]*$/i;

const REPO_URL_RE = /^(https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[^/\s]+\/[^/\s]+)/i;

/** Return a normalized GitHub/GitLab repo URL, or undefined if `u` isn't one. */
function asRepoUrl(u?: string): string | undefined {
  if (!u || typeof u !== "string") return undefined;
  const m = u.match(REPO_URL_RE);
  if (!m) return undefined;
  return m[1].replace(/\.git$/i, "").replace(/\/$/, "");
}

/**
 * Pure parse of `brew info --json=v2 <formula>` into the fields triage needs.
 * Resolves the upstream repo from the homepage first, then the source URLs.
 */
export function parseBrewInfo(json: unknown): BrewInfo {
  const formulae = (json as { formulae?: unknown[] })?.formulae;
  const f = (Array.isArray(formulae) ? formulae[0] : undefined) as
    | {
        name?: string;
        versions?: { stable?: string };
        homepage?: string;
        urls?: { head?: { url?: string }; stable?: { url?: string } };
        deprecated?: boolean;
        disabled?: boolean;
      }
    | undefined;
  if (!f || typeof f !== "object") return { deprecated: false, disabled: false };
  return {
    name: typeof f.name === "string" ? f.name : undefined,
    version: typeof f.versions?.stable === "string" ? f.versions.stable : undefined,
    homepage: typeof f.homepage === "string" ? f.homepage : undefined,
    repoUrl:
      asRepoUrl(f.homepage) ?? asRepoUrl(f.urls?.head?.url) ?? asRepoUrl(f.urls?.stable?.url),
    deprecated: Boolean(f.deprecated),
    disabled: Boolean(f.disabled),
  };
}

/**
 * Triage a Homebrew formula. kit has no brew-specific scoring; instead we resolve
 * the formula's upstream repo via `brew info` and delegate to the existing `repo`
 * channel so the source gets the full health-score. Fail-closed: a disabled
 * formula, or one with no resolvable upstream repo, does NOT pass (we cannot vouch
 * for an un-scored source). `brew info` runs as an arg-array (no shell), and the
 * formula name is validated first to block flag/arg injection.
 */
async function triageBrew(formula: string): Promise<TriageResult> {
  if (!BREW_FORMULA_RE.test(formula)) {
    return {
      target: formula,
      type: "brew",
      passed: false,
      output: `Invalid Homebrew formula name '${formula}'.\nTRIAGE FAILED`,
    };
  }
  let info: BrewInfo;
  try {
    const { stdout } = await exec("brew", ["info", "--json=v2", formula], { timeout: 60_000 });
    info = parseBrewInfo(JSON.parse(stdout));
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return {
      target: formula,
      type: "brew",
      passed: false,
      output: `brew info failed for '${formula}': ${(
        err.stderr ||
        err.message ||
        "is brew installed? https://brew.sh"
      ).trim()}\nTRIAGE FAILED`,
    };
  }

  const label = `${info.name ?? formula}${info.version ? ` ${info.version}` : ""}`;
  if (info.disabled) {
    return {
      target: formula,
      type: "brew",
      passed: false,
      output: `Homebrew formula ${label} is DISABLED.\nTRIAGE FAILED`,
    };
  }

  if (info.repoUrl) {
    const repo = await runTriage("repo", info.repoUrl);
    const dep = info.deprecated ? " (formula DEPRECATED)" : "";
    return {
      target: formula,
      type: "brew",
      // a deprecated formula never auto-passes, even if its upstream scores clean
      passed: repo.passed && !info.deprecated,
      output: `Homebrew formula ${label} -> upstream ${info.repoUrl}${dep}\n${repo.output}`,
    };
  }

  // No GitHub/GitLab upstream resolvable -> source unscored -> fail-closed.
  return {
    target: formula,
    type: "brew",
    passed: false,
    output:
      `Homebrew formula ${label} exists${info.deprecated ? " (DEPRECATED)" : ""}, ` +
      `but no upstream GitHub/GitLab repo was resolvable (homepage: ${info.homepage ?? "n/a"}). ` +
      `Source not scored — treat as UNVERIFIED and review manually.\nTRIAGE FAILED`,
  };
}

/**
 * Run triage on a target
 */
export async function runTriage(type: TriageType, target: string): Promise<TriageResult> {
  if (type === "brew") return triageBrew(target);
  const scriptExists = await ensureTriageScript();
  if (!scriptExists) {
    return {
      target,
      type,
      passed: false,
      output: `Triage script not found at ${TRIAGE_SCRIPT}\nInstall: copy triage skill to ~/.claude/skills/triage/`,
    };
  }

  try {
    const { stdout, stderr } = await exec("python3", [TRIAGE_SCRIPT, type, target], {
      timeout: 300_000, // 5 min for Docker pulls
      // config-declared mirrors, with real env taking precedence
      env: { ...(await airGapMirrorEnv()), ...process.env },
    });

    const output = stdout + (stderr ? `\n${stderr}` : "");
    const passed = verdictPassed(output);

    return { target, type, passed, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = (err.stdout || "") + (err.stderr || "") + (err.message || "");
    return {
      target,
      type,
      passed: false,
      output: output || "Triage script execution failed",
    };
  }
}

/**
 * List available security tools
 */
export async function listTriageTools(): Promise<TriageResult> {
  return runTriage("tools", "");
}

/**
 * Parse the triage output for structured data
 */
export function parseTriageOutput(output: string): {
  healthScore?: string;
  criticalIssues: number;
  warnings: number;
  sections: string[];
} {
  const healthMatch = output.match(/Health score: (\d+\/\d+)/);
  const criticalMatch = output.match(/Critical issues: (\d+)/);
  const warningsMatch = output.match(/Warnings: (\d+)/);
  const sections = output
    .split("──────")
    .filter((s) => s.trim())
    .map((s) => s.trim().split("\n")[0]?.trim())
    .filter(Boolean);

  return {
    healthScore: healthMatch?.[1],
    criticalIssues: criticalMatch ? parseInt(criticalMatch[1]) : 0,
    warnings: warningsMatch ? parseInt(warningsMatch[1]) : 0,
    sections,
  };
}
