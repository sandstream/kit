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
import { hasFlag, flagValue, envTruthy, unknownFlags, GLOBAL_FLAGS } from "../utils/flags.js";
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
  printDeployTable,
  printLockTable,
  printSecurityTable,
  printSummary,
  printHitlBlocks,
} from "../output.js";
import {
  runCheckGate,
  checkRunToJsonChecks,
  CHECK_CATEGORIES,
  parseCategoryFlag,
} from "../check-run.js";
import { syncSecurityFindings } from "../findings-track.js";
import { collectHints } from "../hints.js";
import {
  KIT_VERSION,
  tierNotice,
  type JsonCheck,
  type JsonCheckOutput,
  autoInstallScanners,
  maybeEmitCheckAttestation,
} from "../cli-checks-shared.js";
import { selfUpgrade } from "./upgrade.js";
import { hitlBlocksFromCheckResults } from "../hitl.js";

/**
 * Flags each `kit check` form accepts. An unlisted `--flag` is rejected rather than
 * ignored: `kit check --category security` silently ran the FULL check for as long as
 * it was documented — in kit's own CLAUDE.md and in the Windows CI workflow — because
 * nothing said no. A flag that quietly does nothing is the same defect class as a
 * check that quietly does not run.
 */
// Every flag the check path honors — INCLUDING the ones read by callees, not just the ones this
// file reads. That distinction is the whole trap: `--attest` is consumed in cli-checks-shared.ts
// (`emitAttestation`) and `--no-auto-install` in `autoInstallScanners` in the same module, so an
// allowlist built from this handler's own source rejected two documented, working flags —
// `kit check --attest` (README "Opt-in signed receipt of which scanners ran + the verdict") exited
// 1 with "unknown flag" and the check never ran. A false green's mirror image: a gate that refuses
// to run at all. Anything added here must be verified against the literal the CALLEE reads.
export const CHECK_FLAGS = [
  "--json",
  "--strict",
  "--lenient",
  "--fail-on-warning",
  "--fail-on-worse",
  "--enforce-tests",
  "--category",
  "--pin",
  "--key",
  "--attest", // cli-checks-shared.ts:emitAttestation
  "--no-auto-install", // cli-checks-shared.ts:autoInstallScanners
  // Honored for every command by cli.ts / config.ts, not by the check path itself.
  // Omitting them made `kit check --read-only` and `kit check --non-interactive`
  // — both in the "Global flags" table of docs/COMMANDS.md — exit 1 without
  // running the check: the same false-red as the `--attest` regression above.
  ...GLOBAL_FLAGS,
] as const;
const COMPARE_FLAGS = ["--json", "--fail-on-worse", ...GLOBAL_FLAGS] as const;
const VERIFY_FLAGS = ["--json", "--key", ...GLOBAL_FLAGS] as const;

/** Print the rejection and return false, so every caller fails the same way. */
function rejectUnknownFlags(form: string, allowed: readonly string[]): boolean {
  const bad = unknownFlags(process.argv, allowed);
  if (bad.length === 0) return false;
  const plural = bad.length > 1 ? "s" : "";
  console.error(`${c.red}unknown flag${plural} for ${form}: ${bad.join(", ")}${c.reset}`);
  console.error(`${c.dim}accepted: ${allowed.join(" ")}${c.reset}`);
  return true;
}

export async function cmdCheck(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // kit check verify-attestation <file> verifies a signed check receipt.
  if (process.argv[3] === "verify-attestation") {
    if (rejectUnknownFlags("kit check verify-attestation", VERIFY_FLAGS)) return false;
    return cmdVerifyAttestation();
  }
  // kit check compare <before.json> <after.json> diffs two --json runs.
  if (process.argv[3] === "compare") {
    if (rejectUnknownFlags("kit check compare", COMPARE_FLAGS)) return false;
    return cmdCompare();
  }
  if (rejectUnknownFlags("kit check", CHECK_FLAGS)) return false;

  // --category narrows which dimensions run. An unrecognised value is an error, not
  // a silent full run — the previous behaviour, which made the flag a no-op wherever
  // it was documented.
  const parsed = parseCategoryFlag(flagValue(process.argv, "--category"));
  if (parsed.invalid) {
    const plural = parsed.invalid.length > 1 ? "s" : "";
    console.error(
      `${c.red}unknown --category value${plural}: ${parsed.invalid.join(", ")}${c.reset}`,
    );
    console.error(`${c.dim}accepted: ${CHECK_CATEGORIES.join(" ")}${c.reset}`);
    return false;
  }
  const categories = parsed.categories;

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
        categories,
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
        deploy: deployResults,
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

        const output: JsonCheckOutput = {
          ok: allOk,
          checks,
          summary,
          ...(run.scope ? { scope: run.scope } : {}),
        };
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
      printDeployTable(deployResults);
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

      printSummary(toolResults, serviceResults, secretResults.keys, securityResults, deployResults);
      printHitlBlocks(
        hitlBlocksFromCheckResults({
          config,
          services: serviceResults,
          secrets: secretResults.keys,
          security: securityResults,
          deploy: deployResults,
        }),
      );

      // What the verdict COVERS, counted from the checks that ran. Sibling to the
      // partial-run line below and for the same reason: a scope the reader has to assume
      // is a scope that gets assumed wrong. kit's surface is almost all static analysis,
      // which is the tier that provably cannot distinguish AI-written code from
      // human-written code (see EXECUTING_CATEGORIES) — so it says so rather than letting
      // a green stand in for more than it checked.
      {
        const notice = tierNotice(checkRunToJsonChecks(run));
        if (notice) console.log(`${c.dim}${notice}${c.reset}`);
      }

      // A narrowed run must say so next to its verdict. Without this line a
      // `--category security` pass is visually identical to a full green.
      if (run.scope) {
        console.log(
          `${c.yellow}partial run${c.reset} ${c.dim}— only ${run.scope.join(", ")} ran; ` +
            `this verdict does NOT cover the other dimensions${c.reset}`,
        );
        console.log();
      }

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
/**
 * `kit check compare <before.json> <after.json> [--json] [--fail-on-worse]`
 *
 * Diffs two `kit check --json` documents. Reads only what it was given — no scan is run, so
 * the answer is a pure function of the two files. Exit is success by default even when the
 * diff is bad (this is a report, not a gate); `--fail-on-worse` makes lost coverage, a
 * disappeared check, or a regression non-zero so CI can hold a line on the *delta* rather
 * than on the absolute verdict.
 */
async function cmdCompare(): Promise<boolean> {
  const args = process.argv.slice(4);
  const files = args.filter((a) => !a.startsWith("-"));
  const jsonMode = hasFlag(args, "--json");
  const failOnWorse = hasFlag(args, "--fail-on-worse");
  if (files.length < 2) {
    console.error(
      `${c.red}usage: kit check compare <before.json> <after.json> [--json] [--fail-on-worse]${c.reset}`,
    );
    console.error(`${c.dim}produce the inputs with: kit check --json > before.json${c.reset}`);
    return false;
  }
  const { readFile } = await import("node:fs/promises");
  const { diffScans } = await import("../scan-diff.js");
  const load = async (f: string): Promise<JsonCheckOutput | null> => {
    try {
      const parsed = JSON.parse(await readFile(resolve(process.cwd(), f), "utf-8"));
      // Fail loudly on a document that is not a check run — silently diffing {} against {}
      // would report "clean", which is the exact false green this command exists to catch.
      if (!parsed || !Array.isArray(parsed.checks)) {
        console.error(
          `${c.red}✗ ${f}: not a kit check --json document (no "checks" array)${c.reset}`,
        );
        return null;
      }
      return parsed as JsonCheckOutput;
    } catch (e) {
      console.error(
        `${c.red}✗ cannot read ${f}${c.reset} ${c.dim}(${(e as Error).message})${c.reset}`,
      );
      return null;
    }
  };
  const [before, after] = await Promise.all([load(files[0]), load(files[1])]);
  if (!before || !after) return false;

  const diff = diffScans(before, after);
  if (jsonMode) {
    console.log(JSON.stringify(diff, null, 2));
    return failOnWorse ? !diff.worseThanBefore : true;
  }

  console.log(`${c.bold}kit check compare${c.reset} ${c.dim}${files[0]} → ${files[1]}${c.reset}\n`);
  const icon: Record<string, string> = {
    "coverage-lost": `${c.red}?${c.reset}`,
    disappeared: `${c.red}−${c.reset}`,
    regressed: `${c.red}✗${c.reset}`,
    appeared: `${c.yellow}+${c.reset}`,
    "coverage-gained": `${c.green}+${c.reset}`,
    improved: `${c.green}↑${c.reset}`,
    resolved: `${c.green}✓${c.reset}`,
  };
  const notable = diff.changes.filter((ch) => ch.kind !== "unchanged");
  for (const ch of notable) console.log(`  ${icon[ch.kind] ?? " "} ${ch.summary}`);
  if (notable.length === 0) console.log(`  ${c.dim}no changes${c.reset}`);

  const parts = Object.entries(diff.counts)
    .filter(([k, n]) => n > 0 && k !== "unchanged")
    .map(([k, n]) => `${n} ${k}`);
  console.log(
    `\n${parts.length ? parts.join(" · ") : "nothing changed"}${c.dim} · ${diff.counts.unchanged} unchanged${c.reset}`,
  );
  if (diff.worseThanBefore) {
    console.log(
      `${c.red}Worse than before.${c.reset} ${c.dim}Lost coverage ranks above a regression: a check that stopped running makes its finding unknown, not fixed.${c.reset}`,
    );
  }
  return failOnWorse ? !diff.worseThanBefore : true;
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
