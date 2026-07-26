/**
 * `kit check` command (+ `kit check verify-attestation`) — extracted from cli.ts
 * (5.0-alpha god-module split). cmdCheck is the exported COMMANDS entry;
 * cmdVerifyAttestation is its module-private sub-handler (routed via argv[3]).
 * Shares JsonCheck/autoInstallScanners/maybeEmitCheckAttestation/KIT_VERSION with
 * ci + self-audit via the neutral cli-checks-shared module. Imports only sibling
 * core modules (selfUpgrade from the upgrade command module).
 */
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue, envTruthy } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { withGovernance } from "../governance-middleware.js";
import {
  stepHeader,
  runStep,
  printToolsTable,
  printServicesTable,
  printSecretsTable,
  printSkillsTable,
  printWebSearchStatus,
  printLockTable,
  printSecurityTable,
  printSummary,
} from "../output.js";
import { runCheckGate, checkRunToJsonChecks } from "../check-run.js";
import { syncSecurityFindings } from "../findings-track.js";
import { collectHints } from "../hints.js";
import {
  KIT_VERSION,
  type JsonCheck,
  type JsonCheckOutput,
  autoInstallScanners,
  maybeEmitCheckAttestation,
} from "../cli-checks-shared.js";
import { selfUpgrade } from "./upgrade.js";

export async function cmdCheck(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // kit check verify-attestation <file> verifies a signed check receipt.
  if (process.argv[3] === "verify-attestation") {
    return cmdVerifyAttestation();
  }
  const enforceTests = hasFlag(process.argv, "--enforce-tests");
  // Scanner-health strict by default (see cmdCi): a check that could not RUN fails;
  // --lenient / KIT_CI_LENIENT downgrades those to warnings. Finding-warns stay
  // warnings unless --fail-on-warning / --strict / KIT_CI_STRICT.
  const lenient = hasFlag(process.argv, "--lenient") || envTruthy(process.env.KIT_CI_LENIENT);
  const failOnWarning =
    hasFlag(process.argv, "--fail-on-warning") ||
    hasFlag(process.argv, "--strict") ||
    envTruthy(process.env.KIT_CI_STRICT);
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    {
      operation: "check",
      operationType: "read",
      metadata: {},
    },
    async () => {
      const live = !jsonMode;
      if (live) stepHeader("Checks");
      const step = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
        live ? runStep(label, fn) : fn();

      await autoInstallScanners(config, live); // self-heal missing scanners before scanning
      // Collection + verdict live in the shared core (check-run.ts) — the SAME
      // path the MCP `kit_check` tool and `kit review` use, so the surfaces can
      // never disagree on what runs or what "green" means. The CLI adds its
      // extras around it: spinners (step), PAL sync, attestation, hints.
      const run = await runCheckGate({
        config,
        enforceTests,
        gate: { lenient, failOnWarning },
        step,
      });
      const {
        tools: toolResults,
        services: serviceResults,
        secrets: secretResults,
        skills: skillResults,
        hooks: hookResults,
        webSearch: webSearchResult,
        security: securityResults,
        tests: testResults,
        locks: lockResults,
      } = run;
      const allOk = run.ok;

      // Track security findings in the PAL ledger (cross-session reminders +
      // auto-close on a clean re-scan). Opt out with [memory] track_findings = false.
      if (config.memory?.track_findings !== false) {
        const r = await syncSecurityFindings(securityResults);
        if (!jsonMode && r && (r.added || r.closed.length || r.reopened)) {
          const parts = [`+${r.added} tracked`];
          if (r.reopened) parts.push(`${r.reopened} reopened`);
          if (r.closed.length) parts.push(`−${r.closed.length} auto-closed`);
          console.log(`${c.dim}PAL: ${parts.join(" · ")}${c.reset}`);
        }
      }

      if (jsonMode) {
        // One flattening, shared with `kit review`'s check stage (check-run.ts).
        const checks: JsonCheck[] = checkRunToJsonChecks(run);

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

        const output: JsonCheckOutput = { ok: allOk, checks, summary };
        await maybeEmitCheckAttestation(
          "check",
          allOk,
          summary,
          securityResults.map((s) => ({ id: s.name, status: s.status })),
          true, // quiet: never print to stdout in --json mode
        );
        console.log(JSON.stringify(output, null, 2));
        return allOk;
      }

      printToolsTable(toolResults);
      printServicesTable(serviceResults);
      printSecretsTable(secretResults.templateExists, secretResults.keys);
      printSkillsTable(skillResults);
      printWebSearchStatus(webSearchResult);
      printLockTable(lockResults);

      // Print hooks status if configured
      if (hookResults.length > 0) {
        console.log(`${c.cyan}Git Hooks${c.reset}`);
        for (const r of hookResults) {
          const icon = !r.installed
            ? `${c.red}✗${c.reset}`
            : !r.upToDate
              ? `${c.yellow}!${c.reset}`
              : `${c.green}✓${c.reset}`;
          const status = !r.installed
            ? `${c.red}not installed${c.reset}`
            : !r.upToDate
              ? `${c.yellow}outdated${c.reset}`
              : `${c.green}up-to-date${c.reset}`;
          console.log(`  ${icon} ${r.hookName}  ${status}  ${c.dim}${r.detail}${c.reset}`);
        }
        console.log();
      }

      printSecurityTable(securityResults);

      // Render test-coverage results in the same compact style.
      if (testResults.length > 0) {
        console.log(`\n${c.bold}Tests${c.reset}`);
        for (const r of testResults) {
          const icon =
            r.status === "pass"
              ? `${c.green}✓${c.reset}`
              : r.status === "fail"
                ? `${c.red}✗${c.reset}`
                : r.status === "warn"
                  ? `${c.yellow}!${c.reset}`
                  : `${c.dim}-${c.reset}`;
          console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
          if (r.files && r.files.length > 0) {
            for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
          }
        }
        console.log();
      }

      printSummary(toolResults, serviceResults, secretResults.keys, securityResults);

      // Deterministic, marker-gated "smart" tip — surfaces a relevant opt-in
      // capability (unsigned policy, unanchored audit log, missing trivy, …) at
      // most once. Fail-soft; never affects the verdict. Silence with KIT_NO_HINTS.
      for (const h of await collectHints(process.cwd())) {
        console.log(`${c.dim}💡 tip: ${h.tip}${c.reset}`);
      }

      // Opt-in signed attestation receipt (text mode). Summary is over the
      // security gates, consistent with scanners_ran; overall_ok is the whole
      // check verdict. Emission is fail-soft and never changes the verdict.
      {
        const attSummary = securityResults.reduce(
          (acc, s) => {
            if (s.status === "pass") acc.passed++;
            else if (s.status === "fail") acc.failed++;
            else if (s.status === "warn") acc.warnings++;
            else acc.skipped++;
            return acc;
          },
          { passed: 0, failed: 0, warnings: 0, skipped: 0 },
        );
        await maybeEmitCheckAttestation(
          "check",
          allOk,
          attSummary,
          securityResults.map((s) => ({ id: s.name, status: s.status })),
          false,
        );
      }

      // Surface a stale kit (a newer published version) as a warn — a stale CLI
      // can carry already-fixed bugs. Gated by [update].check; checkForUpdate
      // also self-skips in CI and with KIT_NO_UPDATE_CHECK=1, and returns null
      // when already on latest or the check fails.
      if (config.update?.check !== false) {
        const { checkForUpdate } = await import("../update-check.js");
        const u = await checkForUpdate(KIT_VERSION);
        if (u) {
          if (config.update?.auto === true) {
            // Opt-in auto-update — still WATERTIGHT: selfUpgrade triages kit's own
            // package and installs ONLY on a triage PASS. Never installs on fail.
            console.log(
              `${c.yellow}! kit ${u.current} → ${u.latest} — auto-update on, triaging before install…${c.reset}`,
            );
            await selfUpgrade();
          } else {
            console.log(
              `${c.yellow}! kit ${u.current} → ${u.latest} available${c.reset} ${c.dim}— run ${c.reset}${c.bold}kit upgrade --self${c.reset}${c.dim} (triages before installing)${c.reset}\n`,
            );
          }
        }
      }

      return allOk;
    },
  );
}
async function cmdVerifyAttestation(): Promise<boolean> {
  // kit check verify-attestation [file] [--key <spki|fingerprint>] [--pin]
  const args = process.argv.slice(4);
  const file = args.find((a) => !a.startsWith("-")) ?? ".kit-check-attestation.json";
  const expectedKey = flagValue(args, "--key");
  const doPin = hasFlag(args, "--pin");
  const { readFile } = await import("node:fs/promises");
  const { verifyAttestation, pinEd25519Fingerprint, ATTESTATION_FILE } =
    await import("../check-attestation.js");
  const path = resolve(process.cwd(), file);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    console.error(
      `${c.red}✗ no attestation at ${file}${c.reset}  ${c.dim}(default: ${ATTESTATION_FILE})${c.reset}`,
    );
    return false;
  }
  let att;
  try {
    att = JSON.parse(raw);
  } catch {
    console.error(`${c.red}✗ attestation is not valid JSON: ${file}${c.reset}`);
    return false;
  }
  const r = await verifyAttestation(att, { expectedKey });
  const fpNote = r.fingerprint
    ? `  ${c.dim}ed25519 key sha256:${r.fingerprint.slice(0, 16)}…${c.reset}`
    : "";

  if (r.status === "ok") {
    console.log(
      `${c.green}✓ attestation verified${c.reset}  ${c.dim}${r.sig_alg}: ${att.command} on kit ${att.kit_version}, overall_ok=${att.overall_ok}${c.reset}${fpNote}`,
    );
    if (r.sig_alg === "hmac-sha256") {
      console.log(
        `${c.dim}HMAC verified against the machine-local anchor key (a valid MAC binds the receipt to a key-holder). Does NOT prove the host was untampered - a same-UID key reader can forge.${c.reset}`,
      );
    } else {
      console.log(
        `${c.dim}Ed25519 signature matches the pinned/expected key. Does NOT prove the host was untampered - a same-UID key reader can forge.${c.reset}`,
      );
    }
    return true;
  }

  if (r.status === "unverified-authenticity") {
    // Honest, non-green outcome: valid math, unauthenticated signer.
    if (doPin && r.fingerprint) {
      try {
        await pinEd25519Fingerprint(r.fingerprint);
        console.warn(
          `${c.yellow}! pinned Ed25519 key sha256:${r.fingerprint.slice(0, 16)}… as trusted (TOFU).${c.reset} ${c.dim}Re-run verify to authenticate against the pin. NOTE: pinning a forged receipt's key trusts the forger - only pin a key you know is genuine.${c.reset}`,
        );
        return false; // still not authenticated on THIS run
      } catch (err) {
        console.error(`${c.red}✗ could not pin key: ${(err as Error).message}${c.reset}`);
        return false;
      }
    }
    console.error(
      `${c.yellow}! attestation UNVERIFIED-AUTHENTICITY${c.reset} ${c.dim}(${r.sig_alg})${c.reset}${fpNote}`,
    );
    console.error(`${c.dim}${r.reason}${c.reset}`);
    return false;
  }

  console.error(`${c.red}✗ attestation FAILED: ${r.reason}${c.reset}${fpNote}`);
  return false;
}
