import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { kitConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  category: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passed: number;
  warnings: number;
  failed: number;
}

async function checkNodeVersion(cwd: string): Promise<DoctorCheck> {
  const name = "Node.js version";
  const category = "runtime";

  try {
    const pkgJson = await readFile(join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgJson) as { engines?: { node?: string } };
    const required = pkg?.engines?.node;

    if (!required) {
      return { name, status: "skip", detail: "No engines.node in package.json", category };
    }

    const current = process.version; // "v22.22.2"
    const currentMajor = parseInt(current.replace("v", "").split(".")[0], 10);

    const match = required.match(/(\d+)/);
    const requiredMajor = match ? parseInt(match[1], 10) : null;

    if (requiredMajor === null) {
      return { name, status: "skip", detail: `Cannot parse engines.node: ${required}`, category };
    }

    if (currentMajor >= requiredMajor) {
      return { name, status: "pass", detail: `${current} (requires ${required})`, category };
    } else {
      return { name, status: "fail", detail: `${current} does not satisfy ${required}`, category };
    }
  } catch {
    return { name, status: "skip", detail: "No package.json found", category };
  }
}

async function checkMise(): Promise<DoctorCheck> {
  const name = "mise";
  const category = "tooling";

  try {
    const { stdout } = await execFileAsync("mise", ["--version"]);
    const version = stdout.trim();
    return { name, status: "pass", detail: `installed (${version})`, category };
  } catch {
    return {
      name,
      status: "warn",
      detail: "mise not found — tool installation will not work",
      category,
    };
  }
}

async function checkEnvLocal(config: kitConfig, cwd: string): Promise<DoctorCheck | null> {
  if (!config.secrets) return null;

  const name = ".env.local";
  const category = "secrets";
  const envPath = join(cwd, ".env.local");

  try {
    await access(envPath);
    return { name, status: "pass", detail: ".env.local exists", category };
  } catch {
    return {
      name,
      status: "warn",
      detail: ".env.local not found (run: kit secrets)",
      category,
    };
  }
}

async function checkToolsInPath(config: kitConfig): Promise<DoctorCheck[]> {
  if (!config.tools) return [];

  const checks: DoctorCheck[] = [];

  for (const toolName of Object.keys(config.tools)) {
    const name = `${toolName} in PATH`;
    const category = "tools";

    try {
      const { stdout } = await execFileAsync("which", [toolName]);
      const path = stdout.trim();
      checks.push({ name, status: "pass", detail: path, category });
    } catch {
      checks.push({
        name,
        status: "warn",
        detail: "not in PATH (run: kit install, then re-open terminal)",
        category,
      });
    }
  }

  return checks;
}

async function checkGitHooks(config: kitConfig): Promise<DoctorCheck[]> {
  if (!config.hooks) return [];

  const { checkHooks, isGitRepository } = await import("./check-hooks.js");

  if (!isGitRepository()) {
    return [
      {
        name: "git hooks",
        status: "skip",
        detail: "not a git repository",
        category: "hooks",
      },
    ];
  }

  const hookResults = await checkHooks(config.hooks);
  return hookResults.map((h) => ({
    name: h.hookName,
    category: "hooks",
    status: (!h.installed ? "fail" : !h.upToDate ? "warn" : "pass") as DoctorCheckStatus,
    detail: h.detail,
  }));
}

export async function runDoctor(config: kitConfig, cwd: string): Promise<DoctorResult> {
  const allChecks: DoctorCheck[] = [];

  allChecks.push(await checkNodeVersion(cwd));
  allChecks.push(await checkMise());

  const envLocalCheck = await checkEnvLocal(config, cwd);
  if (envLocalCheck) allChecks.push(envLocalCheck);

  const toolsInPathChecks = await checkToolsInPath(config);
  allChecks.push(...toolsInPathChecks);

  const hookChecks = await checkGitHooks(config);
  allChecks.push(...hookChecks);

  const passed = allChecks.filter((c) => c.status === "pass").length;
  const warnings = allChecks.filter((c) => c.status === "warn").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;

  return { checks: allChecks, passed, warnings, failed };
}
