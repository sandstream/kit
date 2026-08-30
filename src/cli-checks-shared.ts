// Check/CI shared surface, hoisted out of cli.ts (5.0-alpha god-module split) so
// both cmdCheck (still in cli.ts) and cmdCi (commands/ci.ts) can import it without
// a circular dependency back through the entrypoint. Holds the JSON check shapes
// and the two preflight/attestation helpers the check and ci gates share.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { c } from "./utils/colors.js";
import { hasFlag, envTruthy } from "./utils/flags.js";
import { escapeWorkflowCmd, xmlEscape } from "./utils/ci-escape.js";
import type { kitConfig } from "./config.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");

/** kit's own version, read from package.json (same derivation cli.ts uses). */
export const KIT_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }
).version;

/**
 * Check categories whose verdict comes from EXECUTING the code under test rather than
 * reading it. Everything else — secret scans, dependency audits, import rules, manifest
 * checks, registry queries — is static: it inspects text and metadata.
 *
 * The distinction is not pedantry. Multi-tier verification research (arXiv:2607.00107,
 * 8,918 programs across four tiers) found AI-generated code roughly twice as likely as
 * human code to trigger a confirmed runtime violation — while under STATIC analysis the
 * two appear equally safe, a similarity the authors call misleading. The tiers catch
 * largely different classes of defect.
 *
 * kit's check surface is almost entirely the tier that cannot tell those apart. That does
 * not make its green wrong; it makes it NARROWER than a reader assumes, and a gate whose
 * scope is assumed rather than stated is the failure mode this repo keeps finding. So the
 * scope gets printed next to the verdict, counted rather than claimed, so it cannot go
 * stale as categories are added.
 */
export const EXECUTING_CATEGORIES: readonly string[] = ["tests"];

/**
 * One line naming what a green verdict covers. Returns "" for an empty run — there is no
 * scope to state when nothing ran, and the caller already says so.
 */
export function tierNotice(checks: readonly JsonCheck[]): string {
  if (checks.length === 0) return "";
  const executing = checks.filter((k) => EXECUTING_CATEGORIES.includes(k.category)).length;
  const stat = checks.length - executing;
  const runtime =
    executing === 0
      ? "none execute the code"
      : `${executing} execute${executing === 1 ? "s" : ""} it`;
  return (
    `scope: ${checks.length} check(s) — ${stat} inspect the code, ${runtime}. ` +
    `A pass here does not cover runtime behaviour; \`kit broker\` is that tier.`
  );
}

/** One check row in the machine-readable `kit check --json` / `kit ci --json` output. */
export interface JsonCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  category: string;
  files?: string[];
  severity?: "critical" | "high" | "medium" | "low";
  /**
   * True when the check could NOT run (tool absent, token missing, scan crashed) as opposed
   * to an honest not-applicable skip. Carried into the machine-readable document because a
   * consumer that cannot tell those apart will read "stopped failing" where the truth is
   * "stopped looking" — see `scan-diff.ts`, which ranks lost coverage above a regression.
   */
  didNotRun?: boolean;
}

/** The full `--json` document for check / ci. */
export interface JsonCheckOutput {
  ok: boolean;
  checks: JsonCheck[];
  summary: {
    passed: number;
    failed: number;
    warnings: number;
    skipped: number;
    advisories?: number;
  };
  /**
   * Present only when the run was narrowed with `--category`: the dimensions that
   * actually ran. `ok` is then a verdict over THOSE ONLY. Absent means a full run.
   * A consumer that ignores this field will read a partial green as a full one.
   */
  scope?: string[];
}

/** CI output format for `kit ci` / `kit self-audit`, auto-detected from the host. */
export type CiFormat = "github" | "gitlab" | "json" | "text";

/** Detect the CI output format from well-known host env vars. */
export function detectCiFormat(): CiFormat {
  if (process.env.GITHUB_ACTIONS === "true") return "github";
  if (process.env.GITLAB_CI === "true") return "gitlab";
  if (process.env.CI === "true") return "text";
  return "text";
}

/** Emit GitHub Actions `::error::` / `::warning::` annotations for failing/warning checks. */
export function emitGithubAnnotations(checks: JsonCheck[]): void {
  for (const ch of checks) {
    // Carry the offending file:line into the annotation when the finding has one.
    const where = ch.files && ch.files.length > 0 ? ` [${ch.files[0]}]` : "";
    const msg = escapeWorkflowCmd(`${ch.category}/${ch.name}: ${ch.detail}${where}`);
    if (ch.status === "fail") {
      console.log(`::error::${msg}`);
    } else if (ch.status === "warn") {
      console.log(`::warning::${msg}`);
    }
  }
}

/** Write a JUnit XML report (kit-report.xml) for GitLab artifact collection. */
export function emitGitlabJunit(checks: JsonCheck[], allOk: boolean): void {
  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  const skipped = checks.filter(
    (c) => c.status !== "fail" && c.status !== "warn" && c.status !== "pass",
  );
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="kit-ci" tests="${checks.length}" failures="${failures.length}" errors="0" skipped="${skipped.length}">`,
    `  <testsuite name="kit" tests="${checks.length}" failures="${failures.length}" skipped="${skipped.length}">`,
  ];
  for (const ch of checks) {
    lines.push(`    <testcase name="${xmlEscape(ch.name)}" classname="${xmlEscape(ch.category)}">`);
    if (ch.status === "fail") {
      lines.push(`      <failure message="${xmlEscape(ch.detail)}"/>`);
    } else if (ch.status === "warn") {
      lines.push(`      <system-out>${xmlEscape(ch.detail)}</system-out>`);
    } else if (ch.status !== "pass") {
      // JUnit reads an empty testcase as PASSED, so a skipped check used to render green:
      // 24 of 26 checks in a directory where nothing applied (#517). `<skipped>` is the
      // element that exists for exactly this, and the reason goes with it.
      lines.push(`      <skipped message="${xmlEscape(ch.detail)}"/>`);
    }
    lines.push(`    </testcase>`);
  }
  lines.push(`  </testsuite>`, `</testsuites>`);
  const xml = lines.join("\n");
  // Write to file for GitLab artifact collection — synchronous so the report is
  // guaranteed flushed before this (sync) function returns.
  writeFileSync("kit-report.xml", xml, "utf8");
  if (!allOk || warnings.length > 0) {
    console.log(
      `CI report written to kit-report.xml (${failures.length} failures, ${warnings.length} warnings, ${skipped.length} skipped)`,
    );
  }
}

/**
 * Emit a signed attestation receipt for a `kit check` / `kit ci` run, but
 * only when the operator opts in (`--attest` flag or `KIT_ATTEST=1`). Writing a
 * new file into the repo on every run would surprise scripted users, so it is
 * gated. The signing step is fail-soft inside emitAttestation: a signing failure
 * never alters the check verdict; at worst the receipt is unsigned.
 */
export async function maybeEmitCheckAttestation(
  command: "check" | "ci",
  overallOk: boolean,
  summary: { passed: number; failed: number; warnings: number; skipped: number },
  scannersRan: { id: string; status: string }[],
  quiet: boolean,
): Promise<void> {
  if (!hasFlag(process.argv, "--attest") && !envTruthy(process.env.KIT_ATTEST)) return;
  const { emitAttestation } = await import("./check-attestation.js");
  const res = await emitAttestation(
    { command, kitVersion: KIT_VERSION, overallOk, results: summary, scannersRan },
    process.cwd(),
  );
  if (res && !quiet) {
    const signedNote =
      res.att.sig_alg === "none"
        ? `${c.yellow}unsigned (${res.att.unsigned_reason})${c.reset}`
        : `${c.dim}signed ${res.att.sig_alg}${c.reset}`;
    console.log(`${c.dim}attestation: ${res.path}${c.reset} ${signedNote}`);
  }
}

/**
 * Self-healing scanner preflight for `kit check` / `kit ci`. Installs any security
 * scanner declared in `.kit.toml [tools]` but not yet present, so the scan actually
 * RUNS in an ephemeral environment instead of reporting the scanner missing (which
 * fails the strict gate). Complements `kit install` at env-setup — this backstops
 * the case where setup did not run. Opt out with `--no-auto-install` /
 * `KIT_CHECK_NO_AUTOINSTALL`; skipped when air-gapped. installTools is triage-gated
 * and read-only-aware, so this can never run an untriaged binary or write in
 * --read-only mode. Best-effort: a failed install just leaves the check to fail closed.
 */
export async function autoInstallScanners(config: kitConfig, live: boolean): Promise<void> {
  if (!config.tools) return;
  const { ensureScannersInstalled } = await import("./install.js");
  const { resolveAirGap } = await import("./airgap/config.js");
  const disabled =
    hasFlag(process.argv, "--no-auto-install") ||
    ["1", "true", "yes"].includes(
      (process.env.KIT_CHECK_NO_AUTOINSTALL ?? "").trim().toLowerCase(),
    );
  const results = await ensureScannersInstalled(config.tools, {
    disabled,
    airGapped: resolveAirGap(config.air_gap, process.env).enabled,
  });
  const newly = results.filter((r) => r.action === "installed");
  if (live && newly.length) {
    console.log(
      `  ${c.green}✓${c.reset} ${c.dim}auto-installed ${newly
        .map((r) => r.name)
        .join(", ")} so its scan can run${c.reset}`,
    );
  }
}
