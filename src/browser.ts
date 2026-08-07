import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { BrowserConfig } from "./config.js";

export type BrowserVerdictStatus = "pass" | "warn" | "fail" | "skip" | "blocker";
export type BrowserStrategy = "playwright" | "cached-chromium" | "system-chrome" | "cdp" | "none";

export interface BrowserCheck {
  name: string;
  status: BrowserVerdictStatus;
  detail: string;
  command?: string;
}

export interface BrowserAction {
  label: string;
  reason: string;
  command: string;
}

export interface BrowserEnv {
  PLAYWRIGHT_BROWSERS_PATH?: string;
  KIT_BROWSER_STRATEGY: BrowserStrategy;
  KIT_BROWSER_CDP_URL?: string;
}

export interface BrowserDoctorResult {
  status: BrowserVerdictStatus;
  strategy: BrowserStrategy;
  checks: BrowserCheck[];
  actions: BrowserAction[];
  env: BrowserEnv;
  cdp_url?: string;
}

export interface BrowserProbeDeps {
  existsSync?: (path: string) => boolean;
  readdirSync?: (path: string) => string[];
  findOnPath?: (names: string[], envPath?: string) => string | undefined;
  probeUrl?: (url: string) => Promise<boolean>;
  homedir?: () => string;
  platform?: NodeJS.Platform;
}

export interface BrowserDoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deps?: BrowserProbeDeps;
}

interface PlaywrightProbe {
  packagePath?: string;
  cachePath: string;
  browserInstalled: boolean;
}

interface CdpProbe {
  url?: string;
  source?: "env" | "config" | "localhost";
}

const LOCAL_CDP_URL = "http://127.0.0.1:9222";

export async function diagnoseBrowser(
  config: BrowserConfig | undefined,
  options: BrowserDoctorOptions = {},
): Promise<BrowserDoctorResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const deps = normalizeDeps(options.deps);
  const checks: BrowserCheck[] = [];
  const actions: BrowserAction[] = [];

  if (!config) {
    checks.push({
      name: "browser config",
      status: "skip",
      detail: "No [browser] declared in .kit.toml.",
    });
    actions.push({
      label: "Declare browser target",
      reason: "Repo has not opted into browser verification.",
      command: [
        "[browser]",
        'app = "apps/frontend"',
        'start = "npm --workspace apps/frontend run start"',
        'routes = "apps/frontend/e2e/static-routes.spec.ts"',
        "port = 3107",
      ].join("\n"),
    });
    return result("skip", "none", checks, actions);
  }

  checks.push({
    name: "browser config",
    status: "pass",
    detail: "[browser] declared in .kit.toml.",
  });

  if (!config.port) {
    checks.push({
      name: "app port",
      status: "fail",
      detail: "[browser].port is required and must be the app-server port.",
    });
    actions.push({
      label: "Add app port",
      reason: "kit needs a declared app-server port before it can verify browser reachability.",
      command: "Add `port = 3107` under [browser] in .kit.toml.",
    });
    return result("fail", "none", checks, actions);
  }

  checks.push({
    name: "app port",
    status: "pass",
    detail: `[browser].port = ${config.port}`,
  });

  if (config.app) {
    const appPath = resolve(cwd, config.app);
    checks.push(
      deps.existsSync(appPath)
        ? { name: "app path", status: "pass", detail: config.app }
        : { name: "app path", status: "warn", detail: `${config.app} does not exist from repo root.` },
    );
  }

  if (config.routes) {
    const routesPath = resolve(cwd, config.routes);
    checks.push(
      deps.existsSync(routesPath)
        ? { name: "routes spec", status: "pass", detail: config.routes }
        : {
            name: "routes spec",
            status: "warn",
            detail: `${config.routes} does not exist yet. Doctor can still select a browser strategy.`,
          },
    );
  } else {
    checks.push({
      name: "routes spec",
      status: "warn",
      detail: "[browser].routes is not declared; future `kit browser test` will need one.",
    });
  }

  const playwright = probePlaywright(cwd, env, deps);
  if (playwright.packagePath) {
    checks.push({
      name: "playwright package",
      status: "pass",
      detail: playwright.packagePath,
    });
    if (playwright.browserInstalled) {
      checks.push({
        name: "playwright browser",
        status: "pass",
        detail: `Chromium cache found at ${playwright.cachePath}.`,
      });
      return result("pass", "playwright", checks, actions, {
        PLAYWRIGHT_BROWSERS_PATH: playwright.cachePath,
      });
    }

    checks.push({
      name: "playwright browser",
      status: "blocker",
      detail: `Playwright is installed but no Chromium cache was found at ${playwright.cachePath}.`,
      command: "npx playwright install chromium",
    });
    actions.push({
      label: "Install Playwright Chromium",
      reason: "Project Playwright exists; missing browser binaries are a setup blocker, not a cue to guess another test path.",
      command: "npx playwright install chromium",
    });
    return result("blocker", "none", checks, actions);
  }

  checks.push({
    name: "playwright package",
    status: "warn",
    detail: "No project Playwright dependency found.",
  });

  const systemChrome = probeSystemChrome(env, deps);
  if (systemChrome) {
    checks.push({
      name: "system chrome",
      status: "pass",
      detail: systemChrome,
    });
    return result("pass", "system-chrome", checks, actions);
  }

  checks.push({
    name: "system chrome",
    status: "warn",
    detail: "No system Chrome/Chromium executable found.",
  });

  const cdp = await probeCdp(config, env, deps);
  if (cdp.url) {
    checks.push({
      name: "chrome cdp",
      status: "pass",
      detail: `${cdp.url} (${cdp.source})`,
    });
    return result("pass", "cdp", checks, actions, {
      KIT_BROWSER_CDP_URL: cdp.url,
    });
  }

  checks.push({
    name: "chrome cdp",
    status: "blocker",
    detail: "No CDP URL configured and localhost:9222 did not respond.",
  });
  actions.push({
    label: "Start Chrome with CDP",
    reason: "No project Playwright browser, no system Chrome headless path, and no reachable CDP endpoint.",
    command: chromeCdpCommand(deps.platform),
  });
  return result("blocker", "none", checks, actions);
}

export async function resolveBrowserCdpUrl(
  config: BrowserConfig | undefined,
  options: BrowserDoctorOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const deps = normalizeDeps(options.deps);
  return (await probeCdp(config, env, deps)).url;
}

export function resultOk(status: BrowserVerdictStatus): boolean {
  return status !== "fail" && status !== "blocker";
}

export function chromeCdpCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return [
      "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/kit-chrome-profile",
    ].join(" ");
  }
  return [
    "google-chrome",
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/kit-chrome-profile",
  ].join(" ");
}

function result(
  status: BrowserVerdictStatus,
  strategy: BrowserStrategy,
  checks: BrowserCheck[],
  actions: BrowserAction[],
  envPatch: Partial<BrowserEnv> = {},
): BrowserDoctorResult {
  const env: BrowserEnv = { KIT_BROWSER_STRATEGY: strategy, ...envPatch };
  return {
    status,
    strategy,
    checks,
    actions,
    env,
    cdp_url: env.KIT_BROWSER_CDP_URL,
  };
}

function normalizeDeps(deps: BrowserProbeDeps = {}): Required<BrowserProbeDeps> {
  return {
    existsSync: deps.existsSync ?? existsSync,
    readdirSync: deps.readdirSync ?? ((path: string) => readdirSync(path)),
    findOnPath: deps.findOnPath ?? findOnPath,
    probeUrl: deps.probeUrl ?? probeUrl,
    homedir: deps.homedir ?? homedir,
    platform: deps.platform ?? process.platform,
  };
}

function probePlaywright(
  cwd: string,
  env: NodeJS.ProcessEnv,
  deps: Required<BrowserProbeDeps>,
): PlaywrightProbe {
  const packagePath = findFirstExisting(
    [
      join(cwd, "node_modules", "@playwright", "test", "package.json"),
      join(cwd, "node_modules", "playwright", "package.json"),
    ],
    deps.existsSync,
  );
  const cachePath = playwrightBrowsersPath(env, deps);
  return {
    packagePath,
    cachePath,
    browserInstalled: hasChromiumCache(cachePath, deps),
  };
}

function playwrightBrowsersPath(env: NodeJS.ProcessEnv, deps: Required<BrowserProbeDeps>): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (deps.platform === "darwin") return join(deps.homedir(), "Library", "Caches", "ms-playwright");
  if (deps.platform === "win32") return join(deps.homedir(), "AppData", "Local", "ms-playwright");
  return join(deps.homedir(), ".cache", "ms-playwright");
}

function hasChromiumCache(cachePath: string, deps: Required<BrowserProbeDeps>): boolean {
  if (!deps.existsSync(cachePath)) return false;
  try {
    return deps.readdirSync(cachePath).some((entry) => /^chromium/.test(entry));
  } catch {
    return false;
  }
}

function probeSystemChrome(env: NodeJS.ProcessEnv, deps: Required<BrowserProbeDeps>): string | undefined {
  const macCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const mac = deps.platform === "darwin" ? findFirstExisting(macCandidates, deps.existsSync) : undefined;
  if (mac) return mac;
  return deps.findOnPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"], env.PATH);
}

async function probeCdp(
  config: BrowserConfig | undefined,
  env: NodeJS.ProcessEnv,
  deps: Required<BrowserProbeDeps>,
): Promise<CdpProbe> {
  const fromEnv = env.KIT_BROWSER_CDP_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "env" };
  const fromConfig = config?.cdp_url?.trim();
  if (fromConfig) return { url: fromConfig, source: "config" };
  if (await deps.probeUrl(`${LOCAL_CDP_URL}/json/version`)) return { url: LOCAL_CDP_URL, source: "localhost" };
  return {};
}

function findFirstExisting(candidates: readonly string[], exists: (path: string) => boolean): string | undefined {
  return candidates.find((candidate) => exists(candidate));
}

function findOnPath(names: string[], envPath = process.env.PATH): string | undefined {
  const dirs = (envPath ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
