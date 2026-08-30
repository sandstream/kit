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

type MonkeySubcommand = "plan" | "init" | "run";

function subcommand(): MonkeySubcommand | null {
  const raw = process.argv[3];
  if (!raw || raw.startsWith("-")) return "plan";
  if (raw === "plan" || raw === "init" || raw === "run") return raw;
  return null;
}

function usage(): void {
  console.log(`${c.bold}kit monkey-test${c.reset} ${c.dim}(experimental)${c.reset}`);
  console.log("");
  console.log(
    `  ${c.cyan}kit monkey-test plan [--json]${c.reset}                 Detect stack, runner, env, seed, money/security gaps`,
  );
  console.log(
    `  ${c.cyan}kit monkey-test init [--force] [--json]${c.reset}        Create/update the portable Playwright monkey harness`,
  );
  console.log(
    `  ${c.cyan}kit monkey-test run [flags] [--json]${c.reset}           Run security pack + role crawl + sandbox money flow`,
  );
  console.log("");
  console.log(`${c.bold}Run flags:${c.reset}`);
  console.log(`  ${c.green}--base-url <url>${c.reset}        Use an already-running test server`);
  console.log(`  ${c.green}--start-command <cmd>${c.reset}   Start app on a kit-chosen free port`);
  console.log(`  ${c.green}--seed-command <cmd>${c.reset}    Idempotent seed command`);
  console.log(`  ${c.green}--test-command <cmd>${c.reset}    Playwright command override`);
  console.log(
    `  ${c.green}--env-command <cmd>${c.reset}     Print temporary env as JSON or KEY=VALUE lines`,
  );
  console.log(`  ${c.green}--link-depth <n>${c.reset}        Route crawl depth (default 2)`);
  console.log(`  ${c.green}--skip-seed${c.reset}             Requires --expected <reason>`);
  console.log(`  ${c.green}--skip-browser${c.reset}          Requires --expected <reason>`);
  console.log(`  ${c.green}--skip-security${c.reset}         Requires --expected <reason>`);
  console.log("");
  console.log(
    `${c.dim}The generated harness defines roles: public, customer, staff (kiosk staff), owner, superadmin.${c.reset}`,
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

  if (sub === "init") {
    const result = await writeMonkeyHarness(process.cwd(), {
      force: hasFlag(process.argv, "--force"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else renderWrites(result.writes);
    return result.ok;
  }

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
  console.log(`${c.bold}Role matrix${c.reset}`);
  for (const role of plan.roles) {
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
