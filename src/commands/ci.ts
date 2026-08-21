/**
 * `kit ci` command + CI-format helpers — extracted from cli.ts (5.0-alpha
 * god-module split). cmdCi shares JsonCheck/JsonCheckOutput and the
 * autoInstallScanners / maybeEmitCheckAttestation helpers with cmdCheck (which
 * stays in cli.ts); those live in the neutral cli-checks-shared module so
 * neither side imports the other. Imports only sibling core modules.
 */
import { resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { c } from "../utils/colors.js";
import { hasFlag, envTruthy, flagValue } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { withGovernance } from "../governance-middleware.js";
import { stepHeader, runStep } from "../output.js";
import { checkTools } from "../check-tools.js";
import { checkServices } from "../check-services.js";
import { checkSecrets } from "../check-secrets.js";
import { checkSkills } from "../check-skills.js";
import { checkSecurity, gateStatus } from "../check-security.js";
import { checkLockFiles } from "../check-lock.js";
import { evaluatePolicy } from "../policy-check.js";
import {
  type CiFormat,
  type JsonCheck,
  type JsonCheckOutput,
  detectCiFormat,
  emitGithubAnnotations,
  emitGitlabJunit,
  autoInstallScanners,
  maybeEmitCheckAttestation,
} from "../cli-checks-shared.js";

/** Icon per check status. `skip` is its own state — it is neither a pass nor a failure (#517). */
export function statusIcon(status: string): string {
  switch (status) {
    case "pass":
      return "✅";
    case "warn":
      return "⚠️";
    case "fail":
      return "❌";
    default:
      return "➖";
  }
}

/** Report order: what must be acted on first, what could not run last. */
export function statusRank(status: string): number {
  switch (status) {
    case "fail":
      return 0;
    case "warn":
      return 1;
    case "pass":
      return 2;
    default:
      return 3;
  }
}

export async function cmdCi(): Promise<boolean> {
  const args = process.argv.slice(2);

  // `kit ci --init <gitlab|bitbucket>` — emit the pipeline snippet that runs
  // `kit ci` on a non-GitHub host. Prints to stdout (copy-paste); `--write`
  // writes the file only when absent (never clobbers an existing pipeline).
  // Presence is checked separately from the value: `hasFlag` compares whole tokens, so
  // `--init=gitlab` would not register at all and the branch would be skipped silently.
  const initPresent = args.some((a) => a === "--init" || a.startsWith("--init="));
  if (initPresent) {
    const { pipelineSnippet, isCiHost, CI_HOSTS } = await import("../ci-init.js");
    const host = flagValue(args, "--init") ?? "";
    if (!isCiHost(host)) {
      console.error(`kit ci --init: host must be one of ${CI_HOSTS.join(", ")}`);
      return false;
    }
    const { file, content } = pipelineSnippet(host);
    if (hasFlag(args, "--write")) {
      const path = resolve(process.cwd(), file);
      if (existsSync(path)) {
        console.error(`${file} already exists — not overwriting. Snippet to merge in:\n`);
        console.log(content);
        return false;
      }
      writeFileSync(path, content, "utf8");
      console.log(`${c.green}✓${c.reset} wrote ${file}`);
      return true;
    }
    console.log(content);
    return true;
  }

  const formatArg = flagValue(args, "--format") as CiFormat | undefined;
  // Scanner-health STRICT BY DEFAULT (kit's "no false green" floor): a check that
  // could not RUN (tool/token absent, crashed) is marked didNotRun and FAILS the
  // gate — a green means every check actually ran. `--lenient` / KIT_CI_LENIENT
  // downgrades those back to warnings (the pre-3.3 behavior). Finding-level warnings
  // (things a check RAN and flagged) stay warnings unless `--fail-on-warning`, or the
  // max-strict `--strict` / KIT_CI_STRICT which fails on ANY warning.
  const lenient = hasFlag(args, "--lenient") || envTruthy(process.env.KIT_CI_LENIENT);
  const strict = hasFlag(args, "--strict") || envTruthy(process.env.KIT_CI_STRICT);
  const failOnWarning = hasFlag(args, "--fail-on-warning") || strict;
  const jsonMode = hasFlag(args, "--json");
  const format: CiFormat = formatArg ?? (jsonMode ? "json" : detectCiFormat());

  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    { operation: "check", operationType: "read", metadata: {} },
    async () => {
      const live = format === "text";
      if (live) stepHeader("CI checks");
      const step = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
        live ? runStep(label, fn) : fn();

      const toolResults = config.tools ? await step("tools", () => checkTools(config.tools!)) : [];
      const serviceResults = config.services
        ? await step("services", () => checkServices(config.services!))
        : [];
      const secretResults = config.secrets
        ? await step("secrets", () => checkSecrets(config.secrets!))
        : { templateExists: null, keys: [] };
      const skillResults = config.skills
        ? await step("skills", () => checkSkills(config.skills!))
        : [];
      await autoInstallScanners(config, live); // self-heal missing scanners before scanning
      const securityResults = await step("security scan", () => checkSecurity());
      const lockResults = await step("lock files", () => checkLockFiles(config));
      // Signed org policy (.kit-policy.toml) — opt-in (absent ⇒ present:false ⇒ no
      // items ⇒ no effect on the verdict). Folds the same evaluatePolicy() the
      // `kit policy check` command uses into the CI gate, so a tampered/revoked
      // signature, unmet min_kit_version, or (under --strict) a missing required
      // scanner fails CI like any other check.
      const policyReport = await step("policy", () => evaluatePolicy(process.cwd(), { strict }));
      const policyStatus = (s: "pass" | "warn" | "fail" | "n/a"): JsonCheck["status"] =>
        s === "n/a" ? "skip" : s;

      const checks: JsonCheck[] = [
        ...toolResults.map((t) => ({
          name: t.name,
          status: (t.ok ? "pass" : "fail") as JsonCheck["status"],
          detail: t.installed ? `installed ${t.installed}` : "not installed",
          category: "tools",
        })),
        ...serviceResults.map((s) => ({
          name: s.name,
          // Informational services (no CLI login) are a manual-setup warning,
          // not a CI failure.
          status: (s.authenticated
            ? "pass"
            : s.informational
              ? "warn"
              : "fail") as JsonCheck["status"],
          detail: s.informational
            ? s.output || "manual setup (no CLI login)"
            : (s.output ?? (s.authenticated ? "authenticated" : "not authenticated")),
          category: "services",
        })),
        ...secretResults.keys.map((s) => ({
          name: s.name,
          status: (s.unverified ? "warn" : s.available ? "pass" : "fail") as JsonCheck["status"],
          detail: s.detail ?? (s.available ? "available" : "missing"),
          category: "secrets",
        })),
        ...skillResults.map((s) => ({
          name: s.name,
          status: (s.installed ? "pass" : s.required ? "fail" : "warn") as JsonCheck["status"],
          detail: s.installed ? "installed" : "not installed",
          category: "skills",
        })),
        ...lockResults.map((l) => ({
          name: l.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json",
          status: (l.inSync ? "pass" : l.exists ? "warn" : "fail") as JsonCheck["status"],
          detail: l.detail,
          category: "lock",
        })),
        ...securityResults.map((s) => ({
          name: s.name,
          // Scanner-health strict by default: a check that could not run fails the
          // gate unless --lenient. A finding-warn (the check ran + flagged) is untouched.
          status: gateStatus(s, { lenient, failOnWarning }) as JsonCheck["status"],
          detail:
            s.didNotRun && !lenient
              ? `${s.detail}  [did not run — strict default; --lenient to downgrade to warn]`
              : s.detail,
          category: `security/${s.category}`,
        })),
        ...(policyReport.present
          ? [
              ...(policyReport.signature
                ? [
                    {
                      name: "signature",
                      status: policyStatus(policyReport.signature.status),
                      detail: policyReport.signature.detail,
                      category: "policy",
                    },
                  ]
                : []),
              ...policyReport.items.map((i) => ({
                name: i.requirement,
                status: policyStatus(i.status),
                detail: i.detail,
                category: "policy",
              })),
            ]
          : []),
      ];

      const summary = checks.reduce(
        (acc, c) => {
          if (c.status === "pass") acc.passed++;
          else if (c.status === "fail") acc.failed++;
          else if (c.status === "warn") acc.warnings++;
          else acc.skipped++;
          return acc;
        },
        { passed: 0, failed: 0, warnings: 0, skipped: 0 },
      );

      const allOk = summary.failed === 0 && (!failOnWarning || summary.warnings === 0);

      if (format === "github") {
        if (process.env.GITHUB_STEP_SUMMARY) {
          // Emit markdown summary to GitHub Actions step summary. Strip CR/LF so a
          // crafted detail can't inject new markdown/table rows, and escape `|` so
          // it can't forge extra table cells.
          const mdCell = (s: string) =>
            String(s)
              .replace(/[\r\n]+/g, " ")
              .replace(/\|/g, "\\|");
          const lines = [
            "## kit CI Report",
            `| Status | Check | Detail |`,
            `|--------|-------|--------|`,
            // A skip has its own icon. Without one, every not-applicable check rendered ❌ —
            // a run in a directory that is not a project showed 20+ red rows above a footer
            // saying "1 failed", and the deliberate exclusions (Socket cloud-only, a
            // KIT_BUMBLEBEE=0 opt-out, opt-in SAST) read as kit's own design being broken
            // (#517). Failures first, then warnings, then skips: twenty always-red rows at the
            // top is how a report becomes unread.
            ...[...checks]
              .sort((a, b) => statusRank(a.status) - statusRank(b.status))
              .map(
                (c) =>
                  `| ${statusIcon(c.status)} | \`${mdCell(`${c.category}/${c.name}`)}\` | ${mdCell(c.detail)} |`,
              ),
            ``,
            // Skipped belongs in the tally: the rows and the count must add up, or the report
            // contradicts itself in the same output.
            `**${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings, ${summary.skipped} skipped**`,
          ];
          await import("node:fs/promises").then(({ appendFile }) =>
            appendFile(process.env.GITHUB_STEP_SUMMARY!, lines.join("\n") + "\n"),
          );
        }
        emitGithubAnnotations(checks);
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
        );
      } else if (format === "gitlab") {
        emitGitlabJunit(checks, allOk);
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
        );
      } else if (format === "json") {
        const output: JsonCheckOutput = { ok: allOk, checks, summary };
        console.log(JSON.stringify(output, null, 2));
      } else {
        // text
        const failures = checks.filter((c) => c.status === "fail");
        const warnings = checks.filter((c) => c.status === "warn");
        if (failures.length > 0) {
          console.log(`FAILURES:`);
          failures.forEach((f) => console.log(`  ✗ [${f.category}] ${f.name}: ${f.detail}`));
        }
        if (warnings.length > 0) {
          console.log(`WARNINGS:`);
          warnings.forEach((w) => console.log(`  ! [${w.category}] ${w.name}: ${w.detail}`));
        }
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
        );
      }

      // Opt-in signed attestation receipt. scanners_ran reflects the security
      // gates (which ran vs were skipped/errored). Quiet in json/non-text so it
      // never corrupts machine-readable output.
      await maybeEmitCheckAttestation(
        "ci",
        allOk,
        summary,
        securityResults.map((s) => ({ id: s.name, status: s.status })),
        format !== "text",
      );

      return allOk;
    },
  );
}
