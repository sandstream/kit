import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MONKEY_HARNESS_FILES,
  MONKEY_ROLES,
  type MonkeyPackageJson,
  type MonkeyPlanCheck,
  type MonkeyPlanOptions,
  type MonkeyTestPlan,
} from "./monkey-test-contract.js";
import {
  allMonkeyDependencies,
  detectPaymentProviders,
  readMonkeyJson,
  readMonkeyText,
  scanMonkeySources,
} from "./monkey-test-scan.js";
import { securityFindings } from "./monkey-test-security.js";
import { monkeyEnvironmentFindings } from "./monkey-test-runner-env.js";
import { detectStack } from "./stack-detector.js";
import { redactSecrets, secretValuesFromEnv } from "./utils/redactSecrets.js";

function detectPackageManager(
  pkg: MonkeyPackageJson | null,
  cwd: string,
): MonkeyTestPlan["packageManager"] {
  const declared = pkg?.packageManager ?? "";
  if (declared.startsWith("pnpm")) return "pnpm";
  if (declared.startsWith("yarn")) return "yarn";
  if (declared.startsWith("bun")) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (pkg) return "npm";
  return "unknown";
}

function scriptCommand(
  packageManager: MonkeyTestPlan["packageManager"],
  name: string,
): string | undefined {
  if (packageManager === "unknown") return undefined;
  if (packageManager === "npm") return `npm run ${name}`;
  if (packageManager === "pnpm") return `pnpm run ${name}`;
  if (packageManager === "yarn") return `yarn ${name}`;
  return `bun run ${name}`;
}

function pickScript(
  pkg: MonkeyPackageJson | null,
  packageManager: MonkeyTestPlan["packageManager"],
  candidates: RegExp[],
): string | undefined {
  const scripts = pkg?.scripts ?? {};
  for (const candidate of candidates) {
    for (const [name, command] of Object.entries(scripts)) {
      if (candidate.test(name) || candidate.test(command)) {
        return scriptCommand(packageManager, name);
      }
    }
  }
  return undefined;
}

function defaultPlaywrightCommand(
  packageManager: MonkeyTestPlan["packageManager"],
): string | undefined {
  if (packageManager === "npm") {
    return "npx --no-install playwright test -c playwright.monkey.config.ts";
  }
  if (packageManager === "pnpm") {
    return "pnpm exec playwright test -c playwright.monkey.config.ts";
  }
  if (packageManager === "yarn") return "yarn playwright test -c playwright.monkey.config.ts";
  if (packageManager === "bun") return "bunx playwright test -c playwright.monkey.config.ts";
  return undefined;
}

function firstNamedScript(
  scripts: Record<string, string>,
  packageManager: MonkeyTestPlan["packageManager"],
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    if (scripts[name]) return scriptCommand(packageManager, name);
  }
  return undefined;
}

function detectDevCommand(
  pkg: MonkeyPackageJson | null,
  packageManager: MonkeyTestPlan["packageManager"],
): string | undefined {
  const scripts = pkg?.scripts ?? {};
  return (
    firstNamedScript(scripts, packageManager, ["dev", "start", "preview"]) ??
    pickScript(pkg, packageManager, [/^serve$/, /^web$/, /^app$/])
  );
}

function detectTestCommand(
  pkg: MonkeyPackageJson | null,
  packageManager: MonkeyTestPlan["packageManager"],
): string | undefined {
  return (
    pickScript(pkg, packageManager, [/playwright/i, /e2e/i, /^test$/]) ??
    defaultPlaywrightCommand(packageManager)
  );
}

function detectSeedCommand(
  pkg: MonkeyPackageJson | null,
  packageManager: MonkeyTestPlan["packageManager"],
): string | undefined {
  return pickScript(pkg, packageManager, [/seed/i, /db:reset/i, /db:setup/i]) ?? pkg?.prisma?.seed;
}

function detectCommands(
  pkg: MonkeyPackageJson | null,
  packageManager: MonkeyTestPlan["packageManager"],
): MonkeyTestPlan["commands"] {
  const scripts = pkg?.scripts ?? {};
  return {
    dev: detectDevCommand(pkg, packageManager),
    build: scripts.build ? scriptCommand(packageManager, "build") : undefined,
    test: detectTestCommand(pkg, packageManager),
    seed: detectSeedCommand(pkg, packageManager),
  };
}

function redactCommands(commands: MonkeyTestPlan["commands"]): MonkeyTestPlan["commands"] {
  const secrets = secretValuesFromEnv(process.env);
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      command ? redactSecrets(command, secrets) : command,
    ]),
  ) as MonkeyTestPlan["commands"];
}

function detectPlaywright(
  root: string,
  deps: Record<string, string>,
): MonkeyTestPlan["playwright"] {
  return {
    dependency: "@playwright/test" in deps || "playwright" in deps,
    config:
      existsSync(join(root, "playwright.config.ts")) ||
      existsSync(join(root, "playwright.config.js")) ||
      existsSync(join(root, "playwright.config.mjs")),
    monkeyConfig: existsSync(join(root, "playwright.monkey.config.ts")),
  };
}

async function detectEnvironment(
  root: string,
  envCommand: string | undefined,
): Promise<MonkeyTestPlan["env"]> {
  return {
    kitSecrets: /\[secrets\]/.test(await readMonkeyText(join(root, ".kit.toml"))),
    envExample:
      existsSync(join(root, ".env.example")) ||
      existsSync(join(root, ".env.template")) ||
      existsSync(join(root, ".env.sample")),
    envCommand: envCommand ? "provided via --env-command" : undefined,
  };
}

interface CheckInput {
  stack: MonkeyTestPlan["stack"];
  commands: MonkeyTestPlan["commands"];
  playwright: MonkeyTestPlan["playwright"];
  env: MonkeyTestPlan["env"];
  providers: string[];
  harnessMissing: readonly string[];
}

function buildPlanChecks(input: CheckInput): MonkeyPlanCheck[] {
  const { stack, commands, playwright, env, providers, harnessMissing } = input;
  const stackName = `${stack.language}${stack.framework ? `/${stack.framework}` : ""}`;
  const envDetail = env.envCommand
    ? `temporary env from ${env.envCommand}`
    : env.kitSecrets
      ? "kit secrets declared"
      : env.envExample
        ? "env template found"
        : "No env source detected; pass --env-command so secrets stay out of .env files";
  return [
    {
      name: "stack",
      status: stack.language === "unknown" ? "warn" : "pass",
      detail: `${stackName} (${Math.round(stack.confidence * 100)}% confidence)`,
    },
    {
      name: "test runner",
      status: playwright.dependency ? "pass" : "fail",
      detail: playwright.dependency
        ? "Playwright dependency found"
        : "No @playwright/test or playwright dependency found",
      file: "package.json",
    },
    {
      name: "dev server",
      status: commands.dev ? "pass" : "fail",
      detail:
        commands.dev ?? "No dev/start/preview script detected; pass --start-command or --base-url",
      file: "package.json",
    },
    {
      name: "seed",
      status: commands.seed ? "pass" : "warn",
      detail:
        commands.seed ?? "No seed script detected; use --seed-command or --skip-seed with a reason",
      file: "package.json",
    },
    {
      name: "env",
      status: env.envCommand || env.kitSecrets || env.envExample ? "pass" : "warn",
      detail: envDetail,
    },
    {
      name: "money provider",
      status: providers.length > 0 ? "pass" : "warn",
      detail: providers.length > 0 ? providers.join(", ") : "No payment provider marker detected",
    },
    {
      name: "harness",
      status: harnessMissing.length === 0 ? "pass" : "warn",
      detail:
        harnessMissing.length === 0
          ? "monkey-test harness present"
          : `${harnessMissing.length} harness file(s) missing; run kit monkey-test init`,
    },
  ];
}

function buildNextSteps(input: Omit<CheckInput, "stack">): string[] {
  const { commands, playwright, env, providers, harnessMissing } = input;
  const nextSteps: string[] = [];
  if (harnessMissing.length > 0) nextSteps.push("kit monkey-test init");
  if (!playwright.dependency) {
    nextSteps.push("kit triage npm @playwright/test before installing it");
  }
  if (!commands.dev) nextSteps.push("kit monkey-test run --start-command '<dev server command>'");
  if (!commands.seed) {
    nextSteps.push("kit monkey-test run --seed-command '<idempotent seed command>'");
  }
  if (!env.envCommand && !env.kitSecrets) {
    nextSteps.push("provide --env-command '<provider cli that prints KEY=VALUE lines>'");
  }
  if (providers.length > 0) {
    nextSteps.push("set MONKEY_MONEY_ROUTE, MONKEY_ADD_TO_CART, and MONKEY_CHECKOUT");
  }
  return nextSteps;
}

export async function buildMonkeyTestPlan(
  cwd: string = process.cwd(),
  options: MonkeyPlanOptions = {},
): Promise<MonkeyTestPlan> {
  const root = resolve(cwd);
  const pkg = await readMonkeyJson<MonkeyPackageJson>(join(root, "package.json"));
  const deps = allMonkeyDependencies(pkg);
  const stack = await detectStack(root);
  const packageManager = detectPackageManager(pkg, root);
  const commands = redactCommands(detectCommands(pkg, packageManager));
  const scan = await scanMonkeySources(root);
  const providers = detectPaymentProviders(deps, scan.runtimeFiles);
  const playwright = detectPlaywright(root, deps);
  const env = await detectEnvironment(root, options.envCommand);
  const harnessMissing = MONKEY_HARNESS_FILES.filter((file) => !existsSync(join(root, file)));
  const environmentFindings = await monkeyEnvironmentFindings(root, process.env);
  const findings = [...(await securityFindings(root)), ...environmentFindings];
  const checkInput = { stack, commands, playwright, env, providers, harnessMissing };
  const checks = buildPlanChecks(checkInput);
  if (environmentFindings.length > 0) {
    const envCheck = checks.find((check) => check.name === "env")!;
    envCheck.status = "fail";
    envCheck.detail = "Unsafe or unreadable application environment; inspect findings";
  }
  return {
    cwd: root,
    stack,
    packageManager,
    commands,
    playwright,
    env,
    money: {
      providers,
      sandboxOnly:
        environmentFindings.length === 0 &&
        findings.every((finding) => !/live payment|payment credential/i.test(finding.title)),
    },
    harness: { files: [...MONKEY_HARNESS_FILES], missing: harnessMissing },
    roles: MONKEY_ROLES,
    checks,
    findings,
    nextSteps: buildNextSteps(checkInput),
  };
}
