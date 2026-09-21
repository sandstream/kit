import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MONKEY_PLAYWRIGHT_REPORT,
  monkeyFinding,
  prioritizeFindings,
  type MonkeyFinding,
  type MonkeyRunOptions,
  type MonkeyRunResult,
  type MonkeyTestPlan,
} from "./monkey-test-contract.js";
import { runnerRoleMatrixFinding, validatePlaywrightEvidence } from "./monkey-test-evidence.js";
import {
  expectedReasonState,
  livePaymentEnvironmentFindings,
  monkeyEnvironmentFindings,
  parseEnvOutput,
  runnerEnvironment,
} from "./monkey-test-runner-env.js";
import { runShell } from "./monkey-test-process.js";
import { MonkeyProcessScope } from "./monkey-test-runner-processes.js";
import { buildMonkeyTestPlan } from "./monkey-test-plan.js";
import { redactSecrets, secretValuesFromEnv } from "./utils/redactSecrets.js";

interface RunContext {
  root: string;
  options: MonkeyRunOptions;
  plan: MonkeyTestPlan;
  findings: MonkeyFinding[];
  steps: MonkeyRunResult["steps"];
  expectedReasonRaw?: string;
  expectedReason?: string;
  hasExpectedReason: boolean;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  processes: MonkeyProcessScope;
}

interface BrowserRun {
  port?: number;
  baseUrl: string;
}

export { parseEnvOutput };

function safeRunnerText(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return redactSecrets(value, secretValuesFromEnv(env));
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) resolvePort(address.port);
        else reject(new Error("could not allocate a free port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForUrl(url: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, controller.signal]) });
      clearTimeout(timer);
      if (response.status < 500) return true;
    } catch {
      clearTimeout(timer);
    }
    await delay(250, undefined, { signal });
  }
  return false;
}

async function createRunContext(cwd: string, options: MonkeyRunOptions): Promise<RunContext> {
  const root = resolve(cwd);
  const plan = await buildMonkeyTestPlan(root, { envCommand: options.envCommand });
  const expectedReason = expectedReasonState(options);
  const runId = randomUUID();
  return {
    root,
    options,
    plan,
    findings: [],
    steps: [],
    expectedReasonRaw: expectedReason.raw,
    expectedReason: expectedReason.redacted,
    hasExpectedReason: expectedReason.valid,
    timeoutMs: options.timeoutMs ?? 120_000,
    env: runnerEnvironment(options, runId),
    processes: new MonkeyProcessScope(),
  };
}

function applySecurityGate(context: RunContext): void {
  const { options, findings, steps, plan, expectedReason, hasExpectedReason } = context;
  if (!options.skipSecurity) {
    findings.push(...plan.findings);
    steps.push({
      name: "security",
      status: plan.findings.some((finding) => ["critical", "high"].includes(finding.severity))
        ? "fail"
        : "pass",
      detail: `${plan.findings.length} finding(s)`,
    });
    return;
  }
  if (!hasExpectedReason) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "security",
        title: "--skip-security requires --expected <reason>",
        repro: "kit monkey-test run --skip-security",
        fix: "Run the security pack or record a specific expected reason for this release.",
      }),
    );
  }
  steps.push({ name: "security", status: "skip", detail: expectedReason ?? "missing reason" });
}

function missingBrowserSkipReasonFinding(): MonkeyFinding {
  return monkeyFinding({
    severity: "critical",
    area: "runner",
    title: "--skip-browser requires --expected <reason>",
    repro: "kit monkey-test run --skip-browser",
    fix: "Run the browser crawl or record a specific expected reason for this release.",
  });
}

function browserSkipRepro(expectedReason?: string): string {
  const expectedArgument = expectedReason ? ` --expected ${JSON.stringify(expectedReason)}` : "";
  return `kit monkey-test run --skip-browser${expectedArgument}`;
}

function skippedBrowserEvidenceFinding(expectedReason?: string): MonkeyFinding {
  return monkeyFinding({
    severity: "critical",
    area: "runner",
    title: "Browser evidence skipped",
    repro: browserSkipRepro(expectedReason),
    fix: "Restore browser infrastructure and run desktop/mobile role crawls plus the sandbox money flow before release.",
  });
}

function applyBrowserSkipGate(context: RunContext): void {
  const { options, findings, steps, expectedReason, hasExpectedReason } = context;
  if (!options.skipBrowser) return;
  if (!hasExpectedReason) findings.push(missingBrowserSkipReasonFinding());
  findings.push(skippedBrowserEvidenceFinding(expectedReason));
  steps.push({ name: "browser", status: "skip", detail: expectedReason ?? "missing reason" });
}

function applyHarnessPrerequisites(context: RunContext): void {
  const { plan, findings } = context;
  if (!plan.playwright.dependency) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Playwright dependency missing",
        repro: "kit monkey-test plan",
        file: "package.json",
        fix: "Run `kit triage npm @playwright/test`, install it after a pass, then re-run `kit monkey-test init`.",
      }),
    );
  }
  if (plan.harness.missing.length === 0) return;
  findings.push(
    monkeyFinding({
      severity: "critical",
      area: "runner",
      title: "Monkey harness incomplete",
      repro: `Missing: ${plan.harness.missing.join(", ")}`,
      file: plan.harness.missing[0],
      fix: "Run `kit monkey-test init` and commit every generated harness file.",
    }),
  );
}

async function loadTemporaryEnvironment(context: RunContext): Promise<boolean> {
  const { options, root, env, findings, steps } = context;
  if (!options.envCommand) {
    steps.push({ name: "env", status: "skip", detail: "using current process env only" });
    return true;
  }
  const result = await runShell(options.envCommand, {
    cwd: root,
    env,
    timeoutMs: 30_000,
    rawStdout: true,
    processes: context.processes,
  });
  if (!result.ok) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Temporary env command failed",
        repro: "kit monkey-test run --env-command <provider-or-vault-command>",
        fix: "Fix the provider CLI/vault export command. Monkey-test never writes these values to .env.",
      }),
    );
    steps.push({
      name: "env",
      status: "fail",
      detail: result.timedOut
        ? "provider/vault command timed out"
        : `provider/vault exit ${result.exitCode}`,
    });
    return false;
  }
  let loaded: Record<string, string>;
  try {
    loaded = parseEnvOutput(result.stdout);
  } catch {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Temporary env output invalid",
        repro: "kit monkey-test run --env-command <provider-or-vault-command>",
        fix: "Make the provider command print a JSON object or dotenv assignments.",
      }),
    );
    steps.push({ name: "env", status: "fail", detail: "invalid provider output" });
    return false;
  }
  const liveFindings = livePaymentEnvironmentFindings(loaded, "temporary env command");
  if (liveFindings.length > 0) {
    findings.push(...liveFindings);
    steps.push({ name: "env", status: "fail", detail: "live payment environment refused" });
    return false;
  }
  for (const reserved of ["MONKEY_RUN_ID", "MONKEY_BASE_URL", "KIT_MONKEY_PORT", "PORT"]) {
    delete loaded[reserved];
  }
  Object.assign(env, loaded);
  steps.push({ name: "env", status: "pass", detail: "temporary env loaded from command" });
  return true;
}

function restoreRunnerEnvironment(context: RunContext): void {
  context.env.MONKEY_RUN_ID ||= randomUUID();
  if (context.expectedReasonRaw) {
    context.env.MONKEY_EXPECTED_REASON = context.expectedReasonRaw;
  }
}

async function environmentIsSafe(context: RunContext): Promise<boolean> {
  const findings = await monkeyEnvironmentFindings(context.root, context.env);
  for (const finding of findings) {
    if (
      !context.findings.some(
        (existing) =>
          existing.title === finding.title &&
          existing.file === finding.file &&
          existing.repro === finding.repro,
      )
    )
      context.findings.push(finding);
  }
  return findings.length === 0;
}

function stopBeforeSideEffects(context: RunContext, detail: string): MonkeyRunResult {
  context.steps.push({ name: "seed", status: "skip", detail });
  if (!context.options.skipBrowser) {
    context.steps.push({ name: "browser", status: "skip", detail });
  }
  return resultFromContext(context);
}

async function validateRunnerRoleMatrix(context: RunContext): Promise<boolean> {
  const roleMatrixFinding = await runnerRoleMatrixFinding(context.root, context.env);
  if (roleMatrixFinding) context.findings.push(roleMatrixFinding);
  return !roleMatrixFinding;
}

async function runSeed(context: RunContext): Promise<void> {
  const { options, plan, root, env, timeoutMs, findings, steps } = context;
  const seedCommand = options.seedCommand ?? plan.commands.seed;
  const skipSeed = options.skipSeed || process.env.SKIP_SEED === "1";
  if (skipSeed) {
    if (!context.hasExpectedReason) {
      findings.push(
        monkeyFinding({
          severity: "high",
          area: "runner",
          title: "Seed skipped without expected reason",
          repro: "SKIP_SEED=1 kit monkey-test run",
          fix: "Provide --expected <reason> or run the idempotent seed.",
        }),
      );
    }
    steps.push({
      name: "seed",
      status: "skip",
      detail: context.expectedReason ?? "missing reason",
    });
    return;
  }
  if (!seedCommand) {
    findings.push(
      monkeyFinding({
        severity: "high",
        area: "runner",
        title: "No idempotent seed command detected",
        repro: "kit monkey-test plan",
        file: "package.json",
        fix: "Add a seed script or pass --seed-command. Use --skip-seed only with --expected <reason>.",
      }),
    );
    steps.push({ name: "seed", status: "fail", detail: "missing seed command" });
    return;
  }
  const seed = await runShell(seedCommand, {
    cwd: root,
    env,
    timeoutMs,
    stream: true,
    processes: context.processes,
  });
  if (!seed.ok) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Seed command failed",
        repro: safeRunnerText(seedCommand, env),
        fix: "Make the seed idempotent and runnable in test/sandbox mode.",
      }),
    );
  }
  steps.push({
    name: "seed",
    status: seed.ok ? "pass" : "fail",
    detail: safeRunnerText(seedCommand, env),
  });
}

async function startOrValidateServer(
  context: RunContext,
  baseUrl: string,
): Promise<ChildProcess | null> {
  const { options, plan, root, env, findings, steps } = context;
  if (options.baseUrl) {
    const reachable = await waitForUrl(baseUrl, 5_000, context.processes.signal);
    steps.push({
      name: "dev server",
      status: reachable ? "pass" : "fail",
      detail: `${safeRunnerText(baseUrl, env)} ${reachable ? "reachable" : "not reachable"}`,
    });
    if (!reachable) {
      findings.push(
        monkeyFinding({
          severity: "critical",
          area: "runner",
          title: "Base URL is not reachable",
          repro: safeRunnerText(baseUrl, env),
          fix: "Start the app in test mode or let kit start it with --start-command.",
        }),
      );
    }
    return null;
  }

  const startCommand = options.startCommand ?? plan.commands.dev;
  if (!startCommand) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "No dev server command detected",
        repro: "kit monkey-test run",
        file: "package.json",
        fix: "Add a dev/start script or pass --start-command. The runner needs an isolated local port.",
      }),
    );
    return null;
  }
  context.processes.signal.throwIfAborted();
  const server = spawn(startCommand, {
    cwd: root,
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  context.processes.add(server, "server");
  server.stdout?.on("data", () => undefined);
  server.stderr?.on("data", () => undefined);
  const ready = await waitForUrl(baseUrl, 30_000, context.processes.signal);
  steps.push({
    name: "dev server",
    status: ready ? "pass" : "fail",
    detail: ready
      ? `${safeRunnerText(startCommand, env)} on ${safeRunnerText(baseUrl, env)}`
      : `timed out waiting for ${safeRunnerText(baseUrl, env)}`,
  });
  if (!ready) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Dev server did not become reachable",
        repro: safeRunnerText(startCommand, env),
        fix: "Make the start command honor PORT/KIT_MONKEY_PORT or pass --base-url to an already-running test server.",
      }),
    );
  }
  return server;
}

function hasCriticalRunnerFinding(findings: MonkeyFinding[]): boolean {
  return findings.some((finding) => finding.area === "runner" && finding.severity === "critical");
}

async function runPlaywrightGate(context: RunContext): Promise<void> {
  const { options, plan, root, env, timeoutMs, findings, steps } = context;
  const testCommand = options.testCommand ?? plan.commands.test;
  if (!testCommand) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "No Playwright command available",
        repro: "kit monkey-test plan",
        fix: "Install Playwright after triage or pass --test-command.",
      }),
    );
    steps.push({ name: "playwright", status: "fail", detail: "missing command" });
    return;
  }
  await rm(join(root, MONKEY_PLAYWRIGHT_REPORT), { force: true });
  const result = await runShell(testCommand, {
    cwd: root,
    env,
    timeoutMs,
    stream: true,
    processes: context.processes,
  });
  const evidence = result.ok
    ? await validatePlaywrightEvidence(root, env.MONKEY_RUN_ID!)
    : { ok: false, detail: "test command failed before evidence validation" };
  const passed = result.ok && evidence.ok;
  const detail = result.timedOut
    ? "timed out"
    : result.ok
      ? evidence.detail
      : `exit ${result.exitCode}`;
  steps.push({ name: "playwright", status: passed ? "pass" : "fail", detail });
  if (!result.ok) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "ux",
        title: "Playwright monkey crawl failed",
        repro: safeRunnerText(testCommand, env),
        fix: "Read the Playwright failure and monkey-findings attachment, fix real issues, then re-run.",
      }),
    );
    return;
  }
  if (!evidence.ok) {
    findings.push(
      monkeyFinding({
        severity: "critical",
        area: "runner",
        title: "Playwright evidence missing or invalid",
        repro: `${safeRunnerText(testCommand, env)}; inspect ${MONKEY_PLAYWRIGHT_REPORT}`,
        file: MONKEY_PLAYWRIGHT_REPORT,
        fix: "Run the generated monkey harness with both configured projects and preserve its JSON report.",
      }),
    );
  }
}

async function runBrowser(context: RunContext): Promise<BrowserRun> {
  const port = context.options.baseUrl ? undefined : await findFreePort();
  const baseUrl = context.options.baseUrl ?? `http://127.0.0.1:${port}`;
  context.env.KIT_MONKEY_PORT = port ? String(port) : context.env.KIT_MONKEY_PORT;
  context.env.PORT = port ? String(port) : context.env.PORT;
  context.env.MONKEY_BASE_URL = baseUrl;
  let server: ChildProcess | null = null;
  try {
    server = await startOrValidateServer(context, baseUrl);
    if (!hasCriticalRunnerFinding(context.findings) && (await environmentIsSafe(context))) {
      await runPlaywrightGate(context);
    }
  } finally {
    if (server && !(await context.processes.stopChild(server))) {
      context.findings.push(
        monkeyFinding({
          severity: "critical",
          area: "runner",
          title: "Dev server did not stop",
          repro: safeRunnerText(
            context.options.startCommand ?? context.plan.commands.dev ?? "",
            context.env,
          ),
          fix: "Stop the stale process before retrying; make the dev server terminate on SIGTERM.",
        }),
      );
    }
  }
  return { port, baseUrl };
}

function resultFromContext(context: RunContext, browser?: BrowserRun): MonkeyRunResult {
  const findings = prioritizeFindings(context.findings);
  return {
    ok: findings.length === 0,
    plan: context.plan,
    port: browser?.port,
    baseUrl: browser ? safeRunnerText(browser.baseUrl, context.env) : undefined,
    findings,
    steps: context.steps,
  };
}

async function executeRun(context: RunContext): Promise<MonkeyRunResult> {
  const { options } = context;
  applySecurityGate(context);
  applyBrowserSkipGate(context);
  applyHarnessPrerequisites(context);
  if (!options.skipBrowser && hasCriticalRunnerFinding(context.findings)) {
    context.steps.push({ name: "env", status: "skip", detail: "runner prerequisites failed" });
    return stopBeforeSideEffects(context, "runner prerequisites failed");
  }
  if (!(await environmentIsSafe(context))) {
    context.steps.push({ name: "env", status: "fail", detail: "unsafe application environment" });
    return stopBeforeSideEffects(context, "unsafe application environment");
  }
  const envReady = await loadTemporaryEnvironment(context);
  restoreRunnerEnvironment(context);
  const environmentSafe = await environmentIsSafe(context);
  const roleMatrixReady = await validateRunnerRoleMatrix(context);
  if (!envReady) return stopBeforeSideEffects(context, "temporary env command failed");
  if (!environmentSafe) return stopBeforeSideEffects(context, "unsafe application environment");
  if (!options.skipBrowser && !roleMatrixReady) {
    return stopBeforeSideEffects(context, "role matrix prerequisite failed");
  }
  await runSeed(context);
  if (options.skipBrowser) return resultFromContext(context);
  if (context.steps.some((step) => step.name === "seed" && step.status === "fail")) {
    context.steps.push({ name: "browser", status: "skip", detail: "seed prerequisite failed" });
    return resultFromContext(context);
  }
  if (!(await environmentIsSafe(context))) {
    context.steps.push({
      name: "browser",
      status: "skip",
      detail: "unsafe application environment",
    });
    return resultFromContext(context);
  }
  return resultFromContext(context, await runBrowser(context));
}

export async function runMonkeyTest(
  cwd: string = process.cwd(),
  options: MonkeyRunOptions = {},
): Promise<MonkeyRunResult> {
  const context = await createRunContext(cwd, options);
  try {
    return await executeRun(context);
  } finally {
    await context.processes.close();
  }
}
