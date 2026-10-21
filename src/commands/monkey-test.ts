import { c } from "../utils/colors.js";
import { flagInt, flagValue, hasFlag } from "../utils/flags.js";
import {
  buildMonkeyTestPlan,
  runMonkeyTest,
  writeMonkeyHarness,
  type HarnessWrite,
  type MonkeyFinding,
  type MonkeyPlanCheck,
  type MonkeyRunResult,
  type MonkeyTestPlan,
} from "../monkey-test.js";
import { installPlaywright, type InstallResult } from "../monkey-test-install.js";
import {
  DESKTOP_ACTIONS,
  runDesktopMonkey,
  type DesktopAction,
  type DesktopRunResult,
} from "../monkey-test-desktop.js";

type MonkeySubcommand = "plan" | "init" | "run" | "desktop";

function subcommand(): MonkeySubcommand | null {
  const raw = process.argv[3];
  if (!raw || raw.startsWith("-")) return "plan";
  if (raw === "plan" || raw === "init" || raw === "run" || raw === "desktop") return raw;
  return null;
}

function usage(): void {
  console.log(`${c.bold}kit monkey-test${c.reset}`);
  console.log("");
  console.log(
    `  ${c.cyan}kit monkey-test plan [--json]${c.reset}                 Detect stack, desktop shell, env, seed, roles, money/security gaps`,
  );
  console.log(
    `  ${c.cyan}kit monkey-test init [--force] [--install] [--json]${c.reset} Create/update the portable Playwright monkey harness; --install adds a pinned @playwright/test (after triage) and Chromium`,
  );
  console.log(
    `  ${c.cyan}kit monkey-test run [flags] [--json]${c.reset}           Run security pack + role crawl + sandbox money flow`,
  );
  console.log("");
  console.log(`${c.bold}Run flags:${c.reset}`);
  console.log(`  ${c.green}--base-url <url>${c.reset}        Use an already-running test server`);
  console.log(`  ${c.green}--start-command <cmd>${c.reset}   Start app on a kit-chosen free port`);
  console.log(`  ${c.green}--seed-command <cmd>${c.reset}    Idempotent seed command`);
  console.log(
    `  ${c.green}--test-command <cmd>${c.reset}    Diagnostic only; cannot attest browser gate`,
  );
  console.log(
    `  ${c.green}--env-command <cmd>${c.reset}     Print temporary env as JSON or KEY=VALUE lines`,
  );
  console.log(`  ${c.green}--link-depth <n>${c.reset}        Route crawl depth (default 2)`);
  console.log(`  ${c.green}--skip-seed${c.reset}             Requires --expected <reason>`);
  console.log(`  ${c.green}--skip-browser${c.reset}          Requires --expected <reason>`);
  console.log(`  ${c.green}--skip-security${c.reset}         Requires --expected <reason>`);
  console.log("");
  console.log(
    `  ${c.cyan}kit monkey-test desktop [flags] [--json]${c.reset}       Drive the real desktop app: random clicks + interruptions`,
  );
  console.log(`${c.bold}Desktop flags:${c.reset}`);
  console.log(
    `  ${c.green}--seed <n>${c.reset}              Repeat a run exactly (printed in every repro)`,
  );
  console.log(`  ${c.green}--steps <n>${c.reset}             Click steps (default 200)`);
  console.log(
    `  ${c.green}--interruptions <n>${c.reset}     Interruptions during long operations (default 5)`,
  );
  console.log(
    `  ${c.green}--actions <list>${c.reset}        Subset of close-window,quit,kill,reload,restart`,
  );
  console.log(
    `  ${c.green}--config <path>${c.reset}         Default .kit/monkey-test/desktop.json`,
  );
  console.log("");
  console.log(
    `${c.dim}With roles: public, customer, staff (kiosk staff), owner, superadmin. Without auth or payments: public only.${c.reset}`,
  );
}

export async function cmdMonkeyTest(): Promise<boolean> {
  const sub = subcommand();
  if (!sub) {
    usage();
    process.exitCode = 1;
    return false;
  }

  const json = hasFlag(process.argv, "--json");
  if (hasFlag(process.argv, "--help") || hasFlag(process.argv, "-h")) {
    usage();
    return true;
  }

  if (sub === "plan") {
    const plan = await buildMonkeyTestPlan(process.cwd(), {
      envCommand: flagValue(process.argv, "--env-command"),
    });
    if (json) console.log(JSON.stringify(plan, null, 2));
    else renderPlan(plan);
    return plan.checks.every((check) => check.status !== "fail");
  }

  if (sub === "init") return runInit(json);

  if (sub === "desktop") return runDesktop(json);

  const result = await runMonkeyTest(process.cwd(), {
    baseUrl: flagValue(process.argv, "--base-url"),
    startCommand: flagValue(process.argv, "--start-command"),
    seedCommand: flagValue(process.argv, "--seed-command"),
    testCommand: flagValue(process.argv, "--test-command"),
    envCommand: flagValue(process.argv, "--env-command"),
    linkDepth: flagInt(process.argv, "--link-depth", 2),
    skipSeed: hasFlag(process.argv, "--skip-seed"),
    skipBrowser: hasFlag(process.argv, "--skip-browser"),
    skipSecurity: hasFlag(process.argv, "--skip-security"),
    expectedReason: flagValue(process.argv, "--expected"),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else renderRun(result);
  return result.ok;
}

function desktopActions(): DesktopAction[] | null | undefined {
  const raw = flagValue(process.argv, "--actions");
  if (raw === undefined) return undefined;
  const actions = raw.split(",").map((entry) => entry.trim());
  const known = new Set<string>(DESKTOP_ACTIONS);
  if (actions.length === 0 || actions.some((action) => !known.has(action))) return null;
  return actions as DesktopAction[];
}

async function runInit(json: boolean): Promise<boolean> {
  const result = await writeMonkeyHarness(process.cwd(), {
    force: hasFlag(process.argv, "--force"),
  });
  const install = hasFlag(process.argv, "--install")
    ? await installPlaywright(process.cwd())
    : undefined;
  if (json) console.log(JSON.stringify(install ? { ...result, install } : result, null, 2));
  else {
    renderWrites(result.writes);
    if (install) renderInstall(install);
  }
  return result.ok && (install?.ok ?? true);
}

async function runDesktop(json: boolean): Promise<boolean> {
  const actions = desktopActions();
  if (actions === null) {
    console.error(`--actions takes a comma-separated subset of ${DESKTOP_ACTIONS.join(",")}`);
    process.exitCode = 1;
    return false;
  }
  const seedFlag = flagValue(process.argv, "--seed");
  if (seedFlag !== undefined && !/^\d+$/.test(seedFlag)) {
    console.error("--seed takes a whole number, as printed in a finding's repro");
    process.exitCode = 1;
    return false;
  }
  const result = await runDesktopMonkey(process.cwd(), {
    steps: flagInt(process.argv, "--steps", 200),
    seed: seedFlag === undefined ? undefined : Number(seedFlag),
    interruptions: flagInt(process.argv, "--interruptions", 5),
    actions,
    configPath: flagValue(process.argv, "--config"),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else renderDesktop(result);
  return result.ok;
}

function renderDesktop(result: DesktopRunResult): void {
  console.log(
    `${c.bold}kit monkey-test desktop${c.reset} ${result.ok ? c.green + "pass" : c.red + "fail"}${c.reset} ${c.dim}seed ${result.seed}${c.reset}`,
  );
  for (const step of result.steps) {
    console.log(`  ${mark(step.status)} ${step.name.padEnd(12)} ${c.dim}${step.detail}${c.reset}`);
  }
  for (const entry of result.interruptions) {
    console.log(
      `  ${c.dim}step ${entry.step}: ${entry.action} during ${entry.operation} -> ${entry.outcome}${c.reset}`,
    );
  }
  renderFindings(result.findings);
  if (result.keptDataDir) console.log(`\n${c.dim}data kept in ${result.keptDataDir}${c.reset}`);
}

function mark(status: MonkeyPlanCheck["status"] | HarnessWrite["action"]): string {
  if (status === "pass" || status === "created" || status === "updated")
    return `${c.green}✓${c.reset}`;
  if (status === "fail" || status === "skipped") return `${c.red}✗${c.reset}`;
  if (status === "warn") return `${c.yellow}!${c.reset}`;
  return `${c.dim}-${c.reset}`;
}

function renderPlan(plan: MonkeyTestPlan): void {
  console.log(`${c.bold}kit monkey-test plan${c.reset} ${c.dim}${plan.cwd}${c.reset}`);
  console.log("");
  for (const check of plan.checks) {
    const file = check.file ? ` ${c.dim}(${check.file})${c.reset}` : "";
    console.log(
      `  ${mark(check.status)} ${check.name.padEnd(15)} ${c.dim}${check.detail}${c.reset}${file}`,
    );
  }
  console.log("");
  console.log(`${c.bold}Requirements${c.reset}`);
  const { roles, money } = plan.requirements;
  console.log(
    `  roles       ${roles.required ? "required" : "not required"} ${c.dim}${roles.reason}${c.reset}`,
  );
  console.log(
    `  money flow  ${money.required ? "required" : "not required"} ${c.dim}${money.reason}${c.reset}`,
  );
  if (plan.desktop) {
    console.log("");
    console.log(`${c.bold}Desktop app${c.reset}`);
    console.log(`  framework   ${plan.desktop.framework}`);
    console.log(`  drivers     ${plan.desktop.drivers.join(", ")}`);
    for (const dir of plan.desktop.realDataDirs) {
      console.log(`  real data   ${c.dim}${dir}${c.reset}`);
    }
  }
  console.log("");
  console.log(`${c.bold}Role matrix${c.reset}`);
  for (const role of plan.roles.filter((entry) => roles.required || entry.id === "public")) {
    console.log(`  ${c.green}${role.id.padEnd(10)}${c.reset} ${role.label}`);
  }
  renderFindings(plan.findings);
  if (plan.nextSteps.length > 0) {
    console.log("");
    console.log(`${c.bold}Next${c.reset}`);
    for (const step of plan.nextSteps) console.log(`  ${c.yellow}!${c.reset} ${step}`);
  }
}

function renderWrites(writes: HarnessWrite[]): void {
  console.log(`${c.bold}kit monkey-test init${c.reset}`);
  for (const write of writes) {
    const reason = write.reason ? ` ${c.dim}${write.reason}${c.reset}` : "";
    console.log(`  ${mark(write.action)} ${write.action.padEnd(9)} ${write.path}${reason}`);
  }
}

function renderInstall(result: InstallResult): void {
  console.log("");
  console.log(`${c.bold}kit monkey-test init --install${c.reset}`);
  for (const step of result.steps) {
    console.log(`  ${mark(step.status)} ${step.name.padEnd(10)} ${c.dim}${step.detail}${c.reset}`);
  }
}

function renderRun(result: MonkeyRunResult): void {
  console.log(
    `${c.bold}kit monkey-test run${c.reset} ${result.ok ? c.green + "pass" : c.red + "fail"}${c.reset}`,
  );
  if (result.baseUrl) console.log(`  ${c.dim}base URL: ${result.baseUrl}${c.reset}`);
  for (const step of result.steps) {
    console.log(`  ${mark(step.status)} ${step.name.padEnd(12)} ${c.dim}${step.detail}${c.reset}`);
  }
  renderFindings(result.findings);
}

function renderFindings(findings: MonkeyFinding[]): void {
  if (findings.length === 0) {
    console.log("");
    console.log(`${c.green}findings: none${c.reset}`);
    return;
  }
  console.log("");
  console.log(`${c.bold}Findings${c.reset}`);
  for (const finding of findings) {
    const color =
      finding.severity === "critical" ? c.red : finding.severity === "high" ? c.yellow : c.dim;
    const file = finding.file ? ` ${c.dim}${finding.file}${c.reset}` : "";
    console.log(
      `  ${color}[${finding.severity}]${c.reset} ${finding.area} ${finding.role} ${finding.route}: ${finding.title}${file}`,
    );
    console.log(`    ${c.dim}repro:${c.reset} ${finding.repro}`);
    console.log(`    ${c.dim}fix:${c.reset} ${finding.fix}`);
  }
}
