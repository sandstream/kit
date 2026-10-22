/** `kit monkey-test init --install`: triage, then install a pinned @playwright/test and Chromium. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { MonkeyPackageJson, MonkeyTestPlan } from "./monkey-test-contract.js";
import {
  installRunsRepoCode,
  packageManagerRefusal,
  verifyAgainstRegistry,
} from "./monkey-test-install-guards.js";
import { detectPackageManager } from "./monkey-test-plan.js";
import { allMonkeyDependencies, readMonkeyJson } from "./monkey-test-scan.js";
import { runTriage } from "./triage.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

/** Exact version kit installs. Bump it on purpose: the new version goes through triage first. */
export const PLAYWRIGHT_PIN = "1.55.0";

export interface InstallStep {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface InstallResult {
  ok: boolean;
  steps: InstallStep[];
}

export interface InstalledPackage {
  name: string;
  dir: string;
  version: string;
}

/** The cli plus every package whose code it runs: @playwright/test, playwright, playwright-core. */
export interface InstalledCli {
  path: string;
  version: string;
  packages: InstalledPackage[];
}

export interface InstallDeps {
  platform: NodeJS.Platform;
  /** The installed @playwright/test cli and its version, or null when it is not installed. */
  playwrightCli(root: string): InstalledCli | null;
  /** Compare the installed package directory with the public registry tarball for `version`. */
  verifyPackage(
    name: string,
    dir: string,
    version: string,
  ): Promise<{ ok: boolean; detail: string }>;
  triage(target: string): Promise<{ passed: boolean; output: string }>;
  run(command: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }>;
}

type PackageManager = Exclude<MonkeyTestPlan["packageManager"], "unknown">;

const INSTALL_ARGS: Record<PackageManager, { command: string; args: string[] }> = {
  npm: { command: "npm", args: ["install", "--save-dev", "--save-exact", "--ignore-scripts"] },
  pnpm: { command: "pnpm", args: ["add", "--save-dev", "--save-exact", "--ignore-scripts"] },
  yarn: { command: "yarn", args: ["add", "--dev", "--exact", "--ignore-scripts"] },
  bun: { command: "bun", args: ["add", "--dev", "--exact", "--ignore-scripts"] },
};

export const defaultInstallDeps: InstallDeps = {
  platform: process.platform,
  playwrightCli(root) {
    try {
      const path = createRequire(join(root, "package.json")).resolve("@playwright/test/cli");
      const packages: InstalledPackage[] = [];
      let from = path;
      for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
        const manifestPath = createRequire(from).resolve(`${name}/package.json`);
        const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
        if (typeof version !== "string") return null;
        packages.push({ name, dir: dirname(manifestPath), version });
        from = manifestPath;
      }
      return { path, version: packages[0].version, packages };
    } catch {
      return null;
    }
  },
  verifyPackage: verifyAgainstRegistry,
  async triage(target) {
    const result = await runTriage("npm", target);
    return { passed: result.passed, output: result.output };
  },
  async run(command, args, cwd) {
    const result = await execFileNoThrow(command, args, { cwd, timeout: 600_000 });
    return { ok: result.ok, output: `${result.stdout}\n${result.stderr}`.trim() };
  },
};

function tail(output: string): string {
  return output.trim().split("\n").slice(-5).join(" | ");
}

const commandLine = (entry: { command: string; args: string[] }, extra: string[] = []): string =>
  [entry.command, ...entry.args, ...extra].join(" ");

async function fetchBrowser(
  root: string,
  deps: InstallDeps,
  triagedVersion: string | null,
): Promise<InstallStep> {
  // Run the installed cli through node: no package-script lookup (yarn) and no download of an
  // untriaged package (bunx, npx) can stand in for the one that was checked.
  const cli = deps.playwrightCli(root);
  if (!cli) {
    return {
      name: "browser",
      status: "fail",
      detail: "@playwright/test is not installed in node_modules. Install dependencies first.",
    };
  }
  if (cli.version !== triagedVersion) {
    const verdict = await deps.triage(`@playwright/test@${cli.version}`);
    if (!verdict.passed) {
      return {
        name: "browser",
        status: "fail",
        detail: `installed @playwright/test@${cli.version} failed triage: ${tail(verdict.output)}`,
      };
    }
  }
  for (const pkg of cli.packages) {
    const verified = await deps.verifyPackage(pkg.name, pkg.dir, pkg.version);
    if (!verified.ok) {
      return {
        name: "browser",
        status: "fail",
        detail: `Refused to run the installed cli: ${pkg.name}@${pkg.version}: ${verified.detail}`,
      };
    }
  }
  const fetched = await deps.run("node", [cli.path, "install", "chromium"], root);
  return {
    name: "browser",
    status: fetched.ok ? "pass" : "fail",
    detail: fetched.ok ? "chromium downloaded" : tail(fetched.output),
  };
}

export async function installPlaywright(
  root: string,
  deps: InstallDeps = defaultInstallDeps,
): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  const done = (): InstallResult => ({ ok: steps.every((s) => s.status !== "fail"), steps });

  const pkg = await readMonkeyJson<MonkeyPackageJson>(join(root, "package.json"));
  const manager = detectPackageManager(pkg, root);
  if (!pkg || manager === "unknown") {
    steps.push({
      name: "package",
      status: "fail",
      detail: "No package.json found. Run your package manager's init first.",
    });
    return done();
  }
  const refusal = packageManagerRefusal(pkg);
  if (refusal) {
    steps.push({ name: "package", status: "fail", detail: `Refused: ${refusal}.` });
    return done();
  }
  steps.push({ name: "package", status: "pass", detail: `package manager: ${manager}` });

  const spec = `@playwright/test@${PLAYWRIGHT_PIN}`;
  const install = INSTALL_ARGS[manager];
  const declared = "@playwright/test" in allMonkeyDependencies(pkg);

  if (deps.platform === "win32") {
    steps.push({
      name: "install",
      status: "fail",
      detail: `Not run on Windows (.cmd shims need a shell). Run: kit triage npm ${spec}; ${commandLine(install, [spec])}; node node_modules/@playwright/test/cli.js install chromium`,
    });
    return done();
  }

  let triaged: string | null = null;
  if (declared) {
    steps.push({
      name: "dependency",
      status: "skip",
      detail: "@playwright/test is already declared; version left alone",
    });
  } else {
    const hook = installRunsRepoCode(root);
    if (hook) {
      steps.push({
        name: "install",
        status: "fail",
        detail: `Refused: ${hook}, so the install would run repo code that triage does not cover. Install ${spec} yourself after reviewing it.`,
      });
      return done();
    }
    const verdict = await deps.triage(spec);
    steps.push({
      name: "triage",
      status: verdict.passed ? "pass" : "fail",
      detail: verdict.passed ? `${spec} passed triage` : tail(verdict.output),
    });
    if (!verdict.passed) return done();
    triaged = PLAYWRIGHT_PIN;

    const installed = await deps.run(install.command, [...install.args, spec], root);
    steps.push({
      name: "install",
      status: installed.ok ? "pass" : "fail",
      detail: installed.ok
        ? `${spec} saved as an exact devDependency, install scripts skipped`
        : tail(installed.output),
    });
    if (!installed.ok) return done();
  }

  steps.push(await fetchBrowser(root, deps, triaged));
  return done();
}
