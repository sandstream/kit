/**
 * `kit doctor` + `kit add` (Phase A) and `kit setup` + `kit init` (Phase B) —
 * the setup cluster, extracted from cli.ts (5.0-alpha god-module split).
 *
 * Phase B landed once the install/login/check clusters were extracted:
 * cmdSetup orchestrates cmdInstall/cmdLogin/cmdSecrets/cmdCheck (all now
 * sibling command modules), and cmdInit drives cmdSetup, so moving them here
 * no longer risks a commands -> cli.ts back-import. The init/config-generation
 * helpers (generateConfigFile, offerContextLock, offerPosture,
 * offerFirstInstallPrescan) and the [setup]-field runner (runConfiguredCommand)
 * are used only within this cluster, so they stay module-private.
 */
import { readFileSync, existsSync } from "node:fs";
import { writeFile, access, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { c } from "../utils/colors.js";
import { loadConfig, type kitConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { runDoctor } from "../doctor.js";
import { provisionService, listAvailableServices, getServiceInfo } from "../provision.js";
import { executeCommand } from "../run.js";
import { resolveMode, MODE_NAMES } from "../setup-modes.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { isNonInteractive } from "../environment.js";
import { promptConfirm } from "../utils/prompt.js";
import { promptSelect } from "../utils/promptSelect.js";
import { promptMultiSelect } from "../utils/promptMultiSelect.js";
import { isGitRepository } from "../check-hooks.js";
import { checkGitignore, patchGitignore } from "../check-gitignore.js";
import {
  writeAgentConfig,
  installKitPermissions,
  installAllInstallGates,
} from "../agent-config.js";
import { applyRecommendedHardening } from "../recommended.js";
import { runStep } from "../output.js";
import { detectStack } from "../stack-detector.js";
import { scanPlaintextSecrets } from "../scan-plaintext.js";
import { detectSecretStore, vaultMeta } from "../vault-meta.js";
import {
  generateToml,
  parseEnvTemplateKeys,
  type SecretsStore,
  type InitGap,
} from "../toml-generator.js";
import {
  gatherLive,
  suggestContextToml,
  hasLockableContext,
  gcpProjectMismatch,
} from "../context-lock.js";
import {
  readkitMeta,
  readSkillsLock,
  readCliLock,
  updateSkillsLock,
  updateCliLock,
} from "../lock.js";
import { resolveInitServices, userDefaultsPath } from "../user-defaults.js";
import { cmdInstall } from "./install.js";
import { cmdLogin } from "./login.js";
import { cmdSecrets } from "./secrets.js";
import { cmdCheck } from "./check.js";
import { cmdHooks } from "./hooks.js";

export async function cmdDoctor(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit doctor${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  let config: ReturnType<typeof Object.create> = {};
  try {
    config = await loadConfig(resolveConfigPath());
  } catch {
    // Doctor works even without .kit.toml — skip config-dependent checks
  }

  const result = await runDoctor(config, process.cwd());

  for (const check of result.checks) {
    const icon =
      check.status === "pass"
        ? `${c.green}✓${c.reset}`
        : check.status === "warn"
          ? `${c.yellow}⚠${c.reset}`
          : check.status === "fail"
            ? `${c.red}✗${c.reset}`
            : `${c.dim}–${c.reset}`;
    console.log(`  ${icon} ${check.name}  ${c.dim}${check.detail}${c.reset}`);
  }

  console.log();
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);

  const summaryParts: string[] = [];
  if (result.passed > 0) summaryParts.push(`${c.green}${result.passed} passed${c.reset}`);
  if (result.warnings > 0)
    summaryParts.push(
      `${c.yellow}${result.warnings} warning${result.warnings === 1 ? "" : "s"}${c.reset}`,
    );
  if (result.failed > 0) summaryParts.push(`${c.red}${result.failed} failed${c.reset}`);
  if (summaryParts.length === 0) summaryParts.push(`${c.dim}no checks ran${c.reset}`);

  console.log(`\n  ${summaryParts.join(" · ")}\n`);

  return result.failed === 0;
}

export async function cmdAdd(): Promise<boolean> {
  const serviceName = process.argv[3];

  if (!serviceName) {
    console.log(`${c.bold}${c.cyan}Available services:${c.reset}\n`);

    const services = listAvailableServices();
    for (const svc of services) {
      const info = getServiceInfo(svc);
      if (info) {
        console.log(`  ${c.green}${svc}${c.reset}  ${c.dim}${info.description}${c.reset}`);
        console.log(`    ${c.dim}Requires: ${info.tools.join(", ")}${c.reset}`);
      }
    }

    console.log();
    console.log(`${c.dim}Usage: kit add <service>${c.reset}`);
    console.log(`${c.dim}Example: kit add stripe/payments${c.reset}`);
    console.log();
    return false;
  }

  console.log(`${c.bold}${c.cyan}Provisioning ${serviceName}...${c.reset}\n`);

  const projectPath = process.cwd();
  const projectName = process.cwd().split("/").pop();

  const result = await provisionService(serviceName, projectPath, projectName);

  if (result.success) {
    console.log(`  ${c.green}✓${c.reset} ${result.message}`);

    if (result.secrets && Object.keys(result.secrets).length > 0) {
      console.log();
      console.log(`  ${c.dim}Added secrets to .env.local:${c.reset}`);
      for (const key of Object.keys(result.secrets)) {
        console.log(`    ${c.cyan}${key}${c.reset}`);
      }
    }

    if (result.config) {
      console.log();
      console.log(`  ${c.dim}Updated skills-lock.json${c.reset}`);
    }

    console.log();
    return true;
  } else {
    console.log(`  ${c.red}✗${c.reset} ${result.message}`);
    if (result.error) {
      console.log(`  ${c.dim}Error: ${result.error}${c.reset}`);
    }
    console.log();
    return false;
  }
}

/**
 * Run a command string from a `.kit.toml [setup]` field. These are commands the
 * user configured themselves, but kit's exec invariant forbids a shell — so we
 * tokenize like a shell (respecting quotes, so `--arg "a b"` stays one argument)
 * and REFUSE anything with shell operators rather than mis-running it. Returns
 * true on exit 0.
 */
async function runConfiguredCommand(label: string, cmdStr: string): Promise<boolean> {
  if (/[&|;<>`$()]/.test(cmdStr)) {
    console.log(
      `  ${c.yellow}!${c.reset} ${label}: ${c.dim}has shell operators — run it yourself: ${c.reset}${c.bold}${cmdStr}${c.reset}`,
    );
    return false;
  }
  let commandArgs: string[];
  try {
    const { shellSplit } = await import("../utils/shellSplit.js");
    commandArgs = shellSplit(cmdStr);
  } catch {
    console.log(
      `  ${c.yellow}!${c.reset} ${label}: ${c.dim}unbalanced quotes — run it yourself: ${c.reset}${c.bold}${cmdStr}${c.reset}`,
    );
    return false;
  }
  console.log(`  ${c.dim}$ ${cmdStr}${c.reset}`);
  const res = await executeCommand({ commandArgs, cwd: process.cwd() });
  if (res.exitCode === 0) {
    console.log(`  ${c.green}✓${c.reset} ${label}`);
    return true;
  }
  console.log(`  ${c.red}✗${c.reset} ${label} ${c.dim}(exit ${res.exitCode})${c.reset}`);
  return false;
}

export async function cmdSetup(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit setup${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath());

  // Setup MODE — a named preset over the knobs below (flag > [setup].mode > full).
  // full ≡ the historical behavior; other modes gate which steps run + the posture.
  const { profile, requested, recognized } = resolveMode(
    flagValue(process.argv, "--mode"),
    config.setup?.mode,
  );
  if (requested && !recognized) {
    console.log(
      `${c.yellow}!${c.reset} unknown mode "${requested}" — using "full". Modes: ${MODE_NAMES.join(", ")}\n`,
    );
  }
  console.log(
    `${c.dim}mode:${c.reset} ${c.bold}${profile.mode}${c.reset} ${c.dim}— ${profile.blurb}${c.reset}`,
  );
  if (profile.readOnly) {
    process.env.KIT_READ_ONLY = "1"; // review: refuse writes; only config + verify run
    console.log(`${c.dim}read-only review — no installs / logins / secrets / hooks.${c.reset}`);
  }
  console.log();

  // Network posture (connected vs air-gapped enclave): the mode can force it,
  // otherwise prompt. Writes [air_gap]; idempotent — skips if already declared.
  await offerPosture(resolveConfigPath(), config, isNonInteractive(), profile.posture);

  // Recommended profile: an explicit flag always wins; otherwise ASK
  // interactively (the flag is just the scriptable answer to this question).
  // CI/agents without a flag get the core setup — we never silently wire global
  // ~/.claude hooks or the repo's git hooks without an explicit yes.
  let recommended: boolean;
  if (hasFlag(process.argv, "--recommended")) {
    recommended = true;
  } else if (hasFlag(process.argv, "--minimal") || hasFlag(process.argv, "--no-recommended")) {
    recommended = false;
  } else if (isNonInteractive()) {
    recommended = profile.recommended;
  } else {
    recommended = await promptConfirm(
      `Use the recommended profile? Wires cross-harness memory hooks (in ~/.claude) + git secret-scan + triage${config.context ? " + context-check" : ""} gates after the core steps. [Y/n] `,
      10000,
      profile.recommended,
    );
    console.log();
  }

  if (recommended) {
    console.log(
      `${c.dim}Recommended profile on — memory + git hooks wired after the core steps.${c.reset}\n`,
    );
  }

  // Step 1: Install (skipped by modes that don't install tools — agent/review/minimal)
  let installOk = true;
  if (profile.install) {
    console.log(`${c.bold}[1/6] Install${c.reset}`);
    installOk = await cmdInstall();

    if (!installOk) {
      console.log(`${c.red}Install failed — stopping setup.${c.reset}`);
      console.log(
        `${c.dim}Fix the issues above and run ${c.reset}${c.bold}kit setup${c.reset}${c.dim} again.${c.reset}`,
      );
      return false;
    }

    // Project dependencies. cmdInstall above provisions the TOOLCHAIN (node, pnpm,
    // … via mise); now install the project's own deps so the repo actually works
    // after setup. The generated [setup].install was never executed before — kit
    // installed the toolchain but left node_modules absent.
    if (config.setup?.install) {
      await runConfiguredCommand("deps installed", config.setup.install);
    }
  }

  // Step 2: Git Hooks
  if (profile.hooks && config.hooks && Object.keys(config.hooks).length > 0 && isGitRepository()) {
    console.log(`${c.bold}[2/6] Git Hooks${c.reset}`);
    await cmdHooks();
    console.log();
  }

  // Step 3: Login (skipped in airgap/ci/agent/review/minimal — those resolve from a vault)
  let loginOk = true;
  if (profile.login) {
    console.log(`${c.bold}[3/6] Login${c.reset}`);
    loginOk = await cmdLogin();

    if (!loginOk) {
      console.log(`${c.yellow}Some logins failed — continuing with secrets + verify.${c.reset}\n`);
    }
  }

  // Step 4: Secrets (skipped only by review — read-only)
  let secretsOk = true;
  if (profile.secrets) {
    console.log(`${c.bold}[4/6] Secrets${c.reset}`);

    // Harden .gitignore BEFORE secrets are materialized. kit's headline is
    // "secret-safe", but cmdSecrets writes .env.local below — if the repo's
    // .gitignore doesn't already cover it, the next `git add .` stages real
    // secrets. Patching is a non-destructive, repo-local append, so we do it by
    // default and announce it (standalone `kit security check-gitignore --fix`
    // remains for the manual path).
    if (isGitRepository()) {
      const gi = await checkGitignore(process.cwd());
      if (gi.missingPatterns.length > 0) {
        const patched = await patchGitignore(process.cwd());
        const names = gi.missingPatterns
          .slice(0, 3)
          .map((m) => m.pattern)
          .join(", ");
        console.log(
          `  ${c.green}✓${c.reset} hardened .gitignore ${c.dim}(+${patched.added}: ${names}${gi.missingPatterns.length > 3 ? ", …" : ""}) — review + commit it${c.reset}`,
        );
      }
    }

    secretsOk = await cmdSecrets();
  }

  // [setup].migrate / .seed are intentionally NOT auto-run: a configured migrate
  // (`supabase db push`, `prisma migrate deploy`) can mutate a linked — possibly
  // production — database. Run only on explicit opt-in; otherwise surface the
  // exact command so applying it stays a deliberate human action.
  if (config.setup?.migrate || config.setup?.seed) {
    if (hasFlag(process.argv, "--with-migrate")) {
      console.log(`${c.bold}[+] Migrate / seed${c.reset}`);
      if (config.setup.migrate) await runConfiguredCommand("migrate", config.setup.migrate);
      if (config.setup.seed) await runConfiguredCommand("seed", config.setup.seed);
      console.log();
    } else {
      const cmds = [config.setup.migrate, config.setup.seed].filter(Boolean).join("  ·  ");
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}Skipping migrate/seed (may mutate a real DB). Run deliberately: ${c.reset}${c.bold}${cmds}${c.reset}${c.dim}  or  ${c.reset}${c.bold}kit setup --with-migrate${c.reset}`,
      );
    }
  }

  // Step 5: Agent config — teach the present agent(s) to use kit. Idempotent;
  // only writes a managed block, so re-running setup leaves it unchanged.
  console.log(`${c.bold}[5/6] Agent config${c.reset}`);
  const agentResults = await writeAgentConfig();
  for (const r of agentResults) {
    if (r.action === "failed") {
      console.log(`  ${c.yellow}!${c.reset} ${r.agent}: ${r.detail}`);
    } else {
      const mark = r.action === "unchanged" ? `${c.dim}=` : `${c.green}✓`;
      console.log(`  ${mark}${c.reset} ${r.agent} ${c.dim}→ ${r.file} (${r.action})${c.reset}`);
    }
  }
  // Let the agent actually run kit: grant the read-only kit commands (same as
  // `kit agent-config`). Without this the agent hits the permission wall.
  const perms = await installKitPermissions();
  if (perms.action === "created" || perms.action === "updated") {
    console.log(
      `  ${c.green}✓${c.reset} allowed ${perms.added.length} read-only kit command(s) ${c.dim}→ ${perms.file}${c.reset}`,
    );
  }
  // Install the ENFORCEMENT gates too — a block that only advises leaves the floor
  // out, which the gate-liveness check (rightly) fails. `kit agent teach` installs
  // these by default; setup must too, so a fresh setup produces a complete floor.
  for (const { agent, result } of await installAllInstallGates()) {
    if (result.action === "created" || result.action === "updated") {
      console.log(`  ${c.green}✓${c.reset} ${agent} gate ${c.dim}→ ${result.file}${c.reset}`);
    }
  }
  console.log();

  // Step 6: Verify
  console.log(`${c.bold}[6/6] Verify${c.reset}`);
  const verifyOk = await cmdCheck();

  // Recommended hardening: memory hooks + git hooks (opt-in via --recommended).
  if (recommended) {
    console.log(`\n${c.bold}[+] Recommended hardening${c.reset}`);
    const h = await applyRecommendedHardening(config);
    for (const e of h.memory.claude.added)
      console.log(`  ${c.green}✓${c.reset} Claude Code memory hook ${c.dim}${e}${c.reset}`);
    for (const e of h.memory.codex.added)
      console.log(`  ${c.green}✓${c.reset} Codex memory hook ${c.dim}${e}${c.reset}`);
    if (h.memory.claude.added.length === 0 && h.memory.codex.added.length === 0)
      console.log(`  ${c.dim}= memory hooks already wired${c.reset}`);
    if (!h.memory.claude.resolved || !h.memory.codex.resolved) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}memory hooks use a bare \`kit\` (kit not resolvable to an absolute path)${c.reset}`,
      );
    }
    if (h.memory.codex.added.length > 0) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}restart/refresh Codex, then open /hooks and trust the new memory hooks${c.reset}`,
      );
    }
    for (const r of h.hooks) {
      const icon =
        r.action === "failed"
          ? `${c.red}✗`
          : r.action === "skipped"
            ? `${c.yellow}!`
            : `${c.green}✓`;
      console.log(`  ${icon}${c.reset} git ${r.hookName} ${c.dim}(${r.action})${c.reset}`);
    }
    console.log();
  }

  // Project verify (e.g. the configured build). Distinct from cmdCheck above,
  // which audits setup STATE — this proves the app actually builds. Run last so
  // deps + secrets are in place.
  let setupVerifyOk = true;
  if (config.setup?.verify) {
    console.log(`\n${c.bold}[+] Verify build${c.reset}`);
    setupVerifyOk = await runConfiguredCommand(config.setup.verify, config.setup.verify);
    console.log();
  }

  const allOk = installOk && loginOk && secretsOk && verifyOk && setupVerifyOk;

  if (allOk) {
    console.log(`${c.bold}${c.green}Setup complete — you're ready to go! ✓${c.reset}\n`);
  } else {
    console.log(
      `${c.bold}${c.yellow}Setup finished with issues. Run ${c.reset}${c.bold}kit check${c.reset}${c.yellow} to see what's left.${c.reset}\n`,
    );
  }

  return allOk;
}

/**
 * Report the fields kit refused to invent, and the command that settles each.
 *
 * This is the visible half of the no-guessing rule: a shorter .kit.toml is only an
 * improvement if what is missing from it is stated plainly. Silence would just move
 * the surprise from "wrong line in the config" to "check behaves oddly later".
 */
function printInitGaps(gaps: InitGap[]): void {
  if (gaps.length === 0) return;
  console.log(
    `${c.yellow}!${c.reset} ${gaps.length} field(s) kit will not infer ${c.dim}— nothing was guessed:${c.reset}\n`,
  );
  for (const gap of gaps) {
    const who = gap.owner === "human" ? `${c.dim}(needs you)${c.reset}` : "";
    console.log(`  ${c.bold}${gap.path}${c.reset} ${who}`);
    console.log(`    ${c.dim}${gap.why}${c.reset}`);
    if (gap.candidates?.length) {
      console.log(`    ${c.dim}found: ${gap.candidates.join(", ")}${c.reset}`);
    }
    console.log(`    ${c.cyan}${gap.fix}${c.reset}`);
  }
  console.log();
}

/**
 * Generate a `.kit.toml` when none exists: detect stack, surface plaintext
 * secrets, pick a secret backend, preview, and write. Returns "written" on
 * success, "abort-error" when config can't be generated (low-confidence +
 * non-interactive), or "abort-user" when the user declines the write.
 */
async function generateConfigFile(
  configPath: string,
  nonInteractive: boolean,
): Promise<"written" | "abort-error" | "abort-user"> {
  console.log(`${c.yellow}No .kit.toml found.${c.reset}\n`);

  const detected = await runStep("detect project stack", () => detectStack(process.cwd()));
  // Services: detection decides, the operator's known-services list only decides what we
  // ASK about (~/.kit/defaults.toml [init] known_services). `--services a,b` answers on the
  // command line — `--services ""` means none, which is why the flag's presence is tested
  // rather than its truthiness.
  const servicesFlag = hasFlag(process.argv, "--services")
    ? (flagValue(process.argv, "--services") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  let selection = resolveInitServices(detected, servicesFlag);
  if (selection.legacyKey) {
    console.log(
      `${c.dim}${userDefaultsPath()}: [init] services is now a candidate list — rename it to known_services. It no longer adds services to every project.${c.reset}`,
    );
  }
  for (const u of selection.unknown) {
    console.warn(
      `${c.yellow}!${c.reset} unknown service '${u}' — skipped (not in kit's service registry)`,
    );
  }

  // Offer the known-but-absent ones to whoever is here to answer. At a terminal that is a
  // prompt; anywhere else `promptMultiSelect` returns null and they stay a gap, because
  // "nobody answered" must not become "yes".
  if (selection.offered.length > 0 && !nonInteractive) {
    const picked = await promptMultiSelect("Which services does this project use?", [
      ...selection.detected.map((s) => ({
        value: s,
        label: s,
        hint: "found in this repo",
        preselected: true,
      })),
      ...selection.offered.map((s) => ({ value: s, label: s, hint: "you use it elsewhere" })),
    ]);
    if (picked) selection = resolveInitServices(detected, picked);
    console.log();
  }

  const { stack } = selection;

  if (stack.confidence < 0.3 && nonInteractive) {
    console.error(
      `${c.red}✗ Stack detection confidence too low (${(stack.confidence * 100).toFixed(0)}%) — cannot auto-generate config in non-interactive mode.${c.reset}`,
    );
    console.error(`${c.dim}Create a .kit.toml manually or run 'kit init' interactively.${c.reset}`);
    return "abort-error";
  }

  const detectedLabel = [
    stack.language !== "unknown" ? stack.language : null,
    stack.framework ?? null,
    stack.services.length ? stack.services.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" / ");

  if (stack.language === "unknown") {
    console.log(`${c.dim}Could not detect project type — generating minimal config.${c.reset}\n`);
  } else {
    console.log(
      `  ${c.green}✓${c.reset} Detected: ${c.bold}${detectedLabel}${c.reset}  ${c.dim}(confidence: ${(stack.confidence * 100).toFixed(0)}%)${c.reset}`,
    );
    // P4 — turn the confidence signal into a guard. Mis-detections cluster in the low band
    // (~60%) while unambiguous stacks score 85–90%; when we're below that, say so and show how
    // to correct it, rather than committing a possibly-wrong language silently.
    if (stack.confidence < 0.7) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}Low confidence — if this is wrong, set the right language under ${c.reset}${c.bold}[project]${c.reset}${c.dim} in .kit.toml (a polyglot repo can carry several manifests).${c.reset}`,
      );
    }
    console.log();
  }

  // ── Plaintext-secrets scan ─────────────────────────────────────────────
  // Surface obvious credentials sitting in .env / package.json / scripts/
  // BEFORE wiring up the vault, so the choice of backend is informed.
  const plaintextHits = await scanPlaintextSecrets(process.cwd());
  if (plaintextHits.length > 0) {
    const totalFindings = plaintextHits.reduce((sum, h) => sum + h.findings.length, 0);
    console.log(
      `${c.red}⚠ Found ${totalFindings} plaintext secret(s) across ${plaintextHits.length} file(s):${c.reset}`,
    );
    for (const hit of plaintextHits) {
      const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
      console.log(`  ${c.dim}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
    }
    console.log(
      `${c.yellow}These should be migrated to a vault. ` +
        `Pick a secret backend below; we'll wire up the config now and you can run ` +
        `${c.bold}kit secrets migrate${c.reset}${c.yellow} after.${c.reset}\n`,
    );
  }

  // ── Secret-backend choice (interactive) ────────────────────────────────
  // Respect a backend the repo is already bound to (.infisical.json / doppler.yaml);
  // it becomes the default (and the non-interactive choice) instead of 1Password.
  // Order of authority: an explicit --store flag, then a binding the repo already
  // carries (.infisical.json / doppler.yaml), then a human at a real terminal. If
  // none of those produced an answer the store stays UNDEFINED and `[secrets]` is
  // not written — kit does not pick a vault on the user's behalf. It used to
  // default to 1Password, and because `promptSelect` returns its `recommended`
  // option when stdin is not a TTY, that default was applied silently to everyone
  // running `kit init` from an agent or a CI job: op:// refs into a vault they
  // never used, plus the op CLI in [tools] where `kit triage` blocks it.
  const flagStore = flagValue(process.argv, "--store") as SecretsStore | undefined;
  const detectedStore = await detectSecretStore(async (p) => existsSync(resolve(process.cwd(), p)));
  let chosenStore: SecretsStore | undefined = flagStore ?? detectedStore ?? undefined;
  if (!flagStore && detectedStore) {
    console.log(
      `  ${c.green}✓${c.reset} Detected ${c.bold}${detectedStore}${c.reset} config in repo — using it as the secret backend.\n`,
    );
  }
  if (!nonInteractive && !flagStore) {
    const opts = [
      { value: "1password", label: "1Password", hint: "interactive signin via op CLI" },
      { value: "infisical", label: "Infisical", hint: "self-hosted or cloud, token-based" },
      { value: "vault", label: "HashiCorp Vault", hint: "KV v2 paths" },
      { value: "aws-sm", label: "AWS Secrets Manager", hint: "IAM credentials required" },
      { value: "gcp-sm", label: "GCP Secret Manager", hint: "gcloud auth required" },
      { value: "azure-kv", label: "Azure Key Vault", hint: "az login required" },
      { value: "doppler", label: "Doppler", hint: "doppler login required" },
      { value: "bitwarden", label: "Bitwarden", hint: "bw login + unlock required" },
      { value: "env", label: "env (no vault)", hint: "not recommended — use only for local dev" },
    ].map((o) => ({ ...o, recommended: o.value === chosenStore }));
    chosenStore = (await promptSelect("Secret backend?", opts)) as SecretsStore;
    console.log();
  }

  // Detect a Dockerfile so generateToml can provision the trivy container/IaC
  // scanner only where it applies.
  const hasDockerfile =
    existsSync(resolve(process.cwd(), "Dockerfile")) ||
    existsSync(resolve(process.cwd(), "docker-compose.yml")) ||
    existsSync(resolve(process.cwd(), "compose.yml"));

  // Seed [secrets.keys] from an existing .env example so the project's real
  // secret contract isn't lost to just the detected services' template keys.
  let extraSecretKeys: string[] = [];
  let envTemplateFile: string | undefined;
  for (const f of [".env.example", ".env.template", ".env.sample"]) {
    const p = resolve(process.cwd(), f);
    if (existsSync(p)) {
      // Record WHICH file it was: `template` used to be hardcoded to
      // `.env.template`, pointing kit at a path most repos don't have.
      envTemplateFile = f;
      extraSecretKeys = parseEnvTemplateKeys(readFileSync(p, "utf-8"));
      if (extraSecretKeys.length > 0) {
        console.log(
          `  ${c.green}✓${c.reset} Seeded ${extraSecretKeys.length} key(s) from ${c.bold}${f}${c.reset}\n`,
        );
      }
      break;
    }
  }

  // package.json scripts become the candidate list on the setup.verify gap — kit
  // shows what it found and refuses to pick, because only a reader of the repo
  // knows which script is safe to run as a gate.
  let packageScripts: string[] = [];
  try {
    const pkgPath = resolve(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
      };
      packageScripts = Object.keys(pkg.scripts ?? {});
    }
  } catch {
    // Unreadable/!JSON package.json: no candidates, gap still reported.
  }

  const { toml: tomlContent, gaps } = generateToml(stack, {
    ...(chosenStore ? { secretsStore: chosenStore } : {}),
    hasDockerfile,
    extraSecretKeys,
    ...(envTemplateFile ? { envTemplateFile } : {}),
    ...(flagValue(process.argv, "--verify")
      ? { verify: flagValue(process.argv, "--verify") as string }
      : {}),
    ...(flagValue(process.argv, "--install")
      ? { install: flagValue(process.argv, "--install") as string }
      : {}),
    ...(packageScripts.length ? { packageScripts } : {}),
  });

  // Show diff preview
  console.log(`${c.bold}Preview — .kit.toml${c.reset}\n`);
  for (const line of tomlContent.split("\n")) {
    if (line.trim() === "") {
      console.log();
    } else {
      console.log(`  ${c.green}+${c.reset} ${line}`);
    }
  }
  console.log();

  if (!nonInteractive) {
    // Prompt with 5-second default-yes timeout
    const accepted = await promptConfirm("Write this config? [Y/n] (auto-yes in 5s): ", 5000);
    if (!accepted) {
      console.log(`${c.dim}Aborted. Create .kit.toml manually when ready.${c.reset}`);
      return "abort-user";
    }
  }

  await writeFile(configPath, tomlContent, "utf-8");
  console.log(`  ${c.green}✓${c.reset} Generated ${c.bold}.kit.toml${c.reset}\n`);
  printInitGaps([
    // Nobody was here to be asked which of the operator's known services this project
    // uses, so they were left out and reported instead of quietly added.
    ...(selection.offered.length > 0
      ? [
          {
            path: "services",
            owner: "agent" as const,
            why: `you use these elsewhere but nothing in this repo references them`,
            candidates: selection.offered,
            fix: `kit init --services ${[...selection.detected, ...selection.offered].join(",")}`,
          },
        ]
      : []),
    ...gaps,
  ]);

  // Close the loop on the vault choice: tell the user exactly what `kit setup`
  // will provision and what they still have to do themselves (login is their
  // account action — kit guides it, never runs it).
  const meta = vaultMeta(chosenStore);
  if (meta) {
    console.log(`  ${c.dim}Secret backend: ${c.reset}${c.bold}${meta.label}${c.reset}`);
    if (meta.miseTool) {
      console.log(
        `    ${c.green}✓${c.reset} ${c.dim}${c.reset}${c.bold}kit setup${c.reset}${c.dim} will install its CLI via mise${c.reset}`,
      );
    }
    if (meta.loginCmd) {
      const steps = meta.initCmd ? `${meta.loginCmd} && ${meta.initCmd}` : meta.loginCmd;
      console.log(
        `    ${c.yellow}!${c.reset} ${c.dim}then authenticate (your account): ${c.reset}${c.bold}${steps}${c.reset}`,
      );
    }
    console.log();
  }

  return "written";
}

/**
 * Brownfield context-lock offer. If the repo already talks to gcloud / vercel /
 * github but `.kit.toml` declares no `[context]`, surface the detected
 * account+project and offer to lock it. kit does NOT install or authenticate
 * these (cloud env's job) — it locks which account+project this repo is bound to,
 * the exact pairing where cross-account contamination bugs hide. Default is NO:
 * the values are the currently-active CLI state, which is what the lock exists to
 * question, so the user must confirm they're right for THIS repo first.
 */
async function offerContextLock(configPath: string, nonInteractive: boolean): Promise<void> {
  const live = await gatherLive(process.cwd());
  if (!hasLockableContext(live)) return;
  // Never suggest locking a foreign active project (#251): when the repo's own
  // .firebaserc names its projects and the active gcloud context is not one of
  // them, warn with both values and suggest the REPO's project instead.
  const fb = gcpProjectMismatch(live, process.cwd());
  if (fb) {
    console.log(
      `${c.red}✗ active gcloud project ${c.bold}${fb.active}${c.reset}${c.red} is not one of this repo's declared project(s) ${c.bold}${fb.declared.join(", ")}${c.reset}${c.red} (.firebaserc)${c.reset}` +
        `\n  ${c.dim}suggesting the repo's own project below; switch the CLI with:${c.reset} gcloud config set project ${fb.declared[0]}\n`,
    );
    live.gcloud = { account: live.gcloud?.account ?? null, project: fb.declared[0] };
  }
  const block = suggestContextToml(live);
  if (!block.trim()) return;

  console.log(
    `${c.bold}Detected environment${c.reset} ${c.dim}— lock account+project so kit verifies the right one each session:${c.reset}\n`,
  );
  for (const line of block.split("\n")) {
    console.log(line.trim() === "" ? "" : `  ${c.dim}${line}${c.reset}`);
  }
  console.log(
    `\n${c.yellow}⚠ These are the currently-active CLI values — verify each is right for THIS repo before locking.${c.reset}`,
  );

  if (nonInteractive) {
    console.log(
      `${c.dim}Non-interactive: not writing. Add the block above to .kit.toml, or run ${c.reset}${c.bold}kit context check${c.reset}${c.dim} to lock it.${c.reset}\n`,
    );
    return;
  }

  const ok = await promptConfirm("Add this [context] lock to .kit.toml? [y/N] ", 10000, false);
  if (!ok) {
    console.log(
      `${c.dim}Skipped — run ${c.reset}${c.bold}kit context check${c.reset}${c.dim} later to add it.${c.reset}\n`,
    );
    return;
  }
  const existing = readFileSync(configPath, "utf-8");
  await writeFile(configPath, existing.trimEnd() + "\n\n" + block + "\n", "utf-8");
  console.log(
    `  ${c.green}✓${c.reset} Locked ${c.bold}[context]${c.reset} ${c.dim}→ verify with ${c.reset}${c.bold}kit context check${c.reset}\n`,
  );
}

// Network-posture setup step: connected (cloud scanners allowed) vs air-gapped
// enclave (cloud-only scanners dropped, internal mirrors). Writes [air_gap].
// Security: kit NEVER captures/echoes/stores scanner tokens here — connected mode
// only points at where they live (vault [scan.tooling] or env); kit reads them at
// scan time. Idempotent: if a posture is already declared, report it and return.
async function offerPosture(
  configPath: string,
  config: kitConfig,
  nonInteractive: boolean,
  forced: "connected" | "airgap" | null = null,
): Promise<void> {
  if (config.air_gap?.enabled !== undefined) {
    const mode = config.air_gap.enabled ? "air-gapped enclave" : "connected";
    console.log(
      `${c.dim}Network posture: ${c.reset}${c.bold}${mode}${c.reset} ${c.dim}(from .kit.toml [air_gap]).${c.reset}\n`,
    );
    return;
  }
  // A mode (airgap/local/ci/agent) forces the posture — write it without prompting.
  if (forced) {
    const { airGapTomlBlock } = await import("../airgap/config.js");
    const block = airGapTomlBlock(forced === "airgap");
    const existing = readFileSync(configPath, "utf-8");
    await writeFile(configPath, `${existing.trimEnd()}\n\n${block}\n`, "utf-8");
    console.log(
      `  ${c.green}✓${c.reset} posture ${c.bold}${forced}${c.reset} ${c.dim}→ wrote [air_gap] to .kit.toml${c.reset}\n`,
    );
    return;
  }
  if (nonInteractive) {
    console.log(
      `${c.dim}Network posture: connected (default). Set ${c.reset}${c.bold}[air_gap] enabled = true${c.reset}${c.dim} for an air-gapped enclave.${c.reset}\n`,
    );
    return;
  }

  const { airGapTomlBlock } = await import("../airgap/config.js");
  const choice = await promptSelect("Network posture for this project?", [
    {
      value: "connected",
      label: "Connected",
      hint: "cloud scanners (Snyk, Socket) available",
      recommended: true,
    },
    {
      value: "airgap",
      label: "Air-gapped enclave",
      hint: "no egress — cloud-only scanners dropped, offline DBs + internal mirrors",
    },
  ]);

  let block: string;
  if (choice === "airgap") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ask = async (q: string) => (await rl.question(`  ${q} `)).trim();
      console.log(`${c.dim}Internal mirrors (Enter to skip each):${c.reset}`);
      block = airGapTomlBlock(true, {
        npmRegistry: await ask("npm registry URL:"),
        pypiIndex: await ask("PyPI index URL:"),
        githubApi: await ask("GitHub API base URL:"),
        dockerRegistry: await ask("Docker registry URL:"),
        threatDataDir: await ask("Signed threat-data dir (path):"),
      });
    } finally {
      rl.close();
    }
    console.log(
      `\n  ${c.yellow}⚠${c.reset} ${c.dim}Air-gapped: ${c.reset}${c.bold}kit scan${c.reset}${c.dim} drops cloud-only scanners (Snyk, Socket, semgrep) and runs trivy/grype/osv against local DBs. See docs/AIR_GAP.md.${c.reset}`,
    );
  } else {
    block = airGapTomlBlock(false);
    console.log(
      `\n  ${c.dim}Connected: cloud scanners are available. Provide their tokens via your vault ${c.reset}${c.bold}[scan.tooling]${c.reset}${c.dim} or env — kit reads them at scan time and ${c.reset}${c.bold}never stores them${c.reset}${c.dim}:${c.reset}`,
    );
    console.log(
      `    ${c.green}SNYK_TOKEN${c.reset}                 ${c.dim}→ kit scan runs Snyk${c.reset}`,
    );
    console.log(
      `    ${c.green}SOCKET_SECURITY_API_TOKEN${c.reset}  ${c.dim}→ kit scan runs Socket (socket ci)${c.reset}`,
    );
  }

  const existing = readFileSync(configPath, "utf-8");
  await writeFile(configPath, `${existing.trimEnd()}\n\n${block}\n`, "utf-8");
  console.log(
    `\n  ${c.green}✓${c.reset} Wrote ${c.bold}[air_gap]${c.reset} ${c.dim}(${choice === "airgap" ? "enabled" : "disabled"}) to .kit.toml${c.reset}\n`,
  );
}

export async function cmdInit(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit init${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // A missing TTY counts as non-interactive. It was previously derived from flags
  // alone, so `kit init` run from an agent, a hook or CI took the INTERACTIVE
  // branch — and `promptSelect` answers with its `recommended` option when stdin
  // is not a TTY. Every prompt was therefore auto-answered with kit's own default
  // and never shown to anybody. Prompts are for questions a person is present to
  // answer; where nobody is, the answer must be "unknown", not "kit's favourite".
  const nonInteractive =
    hasFlag(process.argv, "--non-interactive") ||
    hasFlag(process.argv, "--yes") ||
    hasFlag(process.argv, "-y") ||
    !process.stdin.isTTY;

  const configPath = resolveConfigPath();

  // ── Auto-generate .kit.toml if absent ──────────────────────────────────
  let configMissing = false;
  try {
    await access(configPath);
  } catch {
    configMissing = true;
  }

  if (configMissing) {
    const result = await generateConfigFile(configPath, nonInteractive);
    if (result === "abort-error") return false; // can't generate (low confidence + non-interactive)
    if (result === "abort-user") return true; // user declined — exit 0, not an error
  }

  const config = await loadConfig(configPath);

  // Brownfield: offer to lock the already-active cloud/repo context (no install,
  // no login — just pin account+project) when none is declared yet.
  if (!config.context) {
    await offerContextLock(configPath, nonInteractive);
  }

  // Check if lock files exist
  const kitMeta = await readkitMeta();
  const skillsLock = await readSkillsLock();
  const cliLock = await readCliLock();

  if (kitMeta) {
    console.log(`${c.dim}kit: ${kitMeta.name}@${kitMeta.version}${c.reset}\n`);
  }

  if (!skillsLock && !cliLock) {
    console.log(`${c.yellow}No lock files found.${c.reset}`);
    console.log(`${c.dim}Generating lock files from .kit.toml...${c.reset}\n`);

    // Generate lock files from config
    await runStep("generate lock files", async () => {
      const skills: Record<string, string> = {};
      if (config.skills?.required) {
        Object.assign(skills, config.skills.required);
      }
      if (config.skills?.optional) {
        Object.assign(skills, config.skills.optional);
      }

      await updateSkillsLock(
        skills,
        kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined,
      );

      const tools: Record<
        string,
        { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }
      > = {};
      if (config.tools) {
        for (const [name, version] of Object.entries(config.tools)) {
          tools[name] = { version, source: "mise" };
        }
      }

      await updateCliLock(tools);
    });
    console.log();
  }

  // --no-setup: stop after .kit.toml + lock files; skip install / login / secrets.
  // (Mirrors `kit clone --no-setup`; previously `kit init` silently ignored this flag
  // and ran full setup anyway.)
  if (hasFlag(process.argv, "--no-setup")) {
    console.log(
      `${c.yellow}Setup skipped (--no-setup): .kit.toml + lock files generated; install / login / secrets not run.${c.reset}`,
    );
    return true;
  }

  // Now run the setup process
  const setupOk = await cmdSetup();

  // First-install hook: offer a global prescan against an operator-chosen
  // root (typically ~/projects). Asked once, marker written to
  // ~/.kit/first-install-prompted so re-runs of `kit init` (per
  // additional repos) don't re-ask. Honors --non-interactive/--yes/-y.
  if (setupOk && !nonInteractive) {
    await offerFirstInstallPrescan();
  }
  return setupOk;
}

async function offerFirstInstallPrescan(): Promise<void> {
  const homedir = (await import("node:os")).homedir();
  const markerDir = join(homedir, ".kit");
  const markerPath = join(markerDir, "first-install-prompted");
  try {
    await access(markerPath);
    return; // Already prompted on this machine.
  } catch {
    // Marker absent — proceed with prompt.
  }
  if (!process.stdin.isTTY) return;

  console.log();
  console.log(`${c.bold}${c.cyan}First-install: multi-repo prescan${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`${c.dim}kit can scan every git repo under a directory for leaked secrets,`);
  console.log(
    `${c.dim}.gitignore holes, public-repo + credential combos, and CVE-deps.${c.reset}\n`,
  );

  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  let scanPath = "";
  try {
    answer = (await rl.question(`Run a prescan now? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      const defaultPath = join(homedir, "projects");
      scanPath = (await rl.question(`Path to scan [${defaultPath}]: `)).trim() || defaultPath;
    }
  } finally {
    rl.close();
  }

  // Always write marker (even if user declined) — don't re-pester.
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, new Date().toISOString() + "\n", { encoding: "utf-8", mode: 0o600 });

  if (answer !== "y" && answer !== "yes") {
    console.log(
      `${c.dim}Skipped. Run later with ${c.bold}kit security prescan <path>${c.reset}${c.dim}.${c.reset}\n`,
    );
    return;
  }

  console.log(`${c.dim}Running prescan against ${scanPath}…${c.reset}\n`);
  const { runPrescan } = await import("../security-prescan.js");
  const report = await runPrescan({ root: resolve(scanPath), deep: false });
  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of report.findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  console.log(
    `${c.bold}Scanned${c.reset} ${report.repoCount} repo(s), ${report.findings.length} finding(s):`,
  );
  if (bySev.critical) console.log(`  ${c.red}critical${c.reset}: ${bySev.critical}`);
  if (bySev.high) console.log(`  ${c.red}high    ${c.reset}: ${bySev.high}`);
  if (bySev.medium) console.log(`  ${c.yellow}medium  ${c.reset}: ${bySev.medium}`);
  if (bySev.low) console.log(`  ${c.dim}low     ${c.reset}: ${bySev.low}`);
  if (report.summaryPath) {
    console.log(`\n${c.dim}Full report:${c.reset} ${report.summaryPath}`);
  }
  console.log();
}
