import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { kitConfig } from "./config.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { activeKeyStoreStatus, hardwareRequired } from "./keystore/active.js";

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

async function checkMisePath(): Promise<DoctorCheck | null> {
  const { miseShimsDir, isDirOnPath, activationLine } = await import("./mise-path.js");
  const shims = miseShimsDir();
  try {
    await access(shims);
  } catch {
    return null; // no mise shims here → nothing to check
  }
  if (isDirOnPath(process.env.PATH, shims)) {
    return { name: "mise tools on PATH", status: "pass", detail: shims, category: "tools" };
  }
  return {
    name: "mise tools on PATH",
    status: "warn",
    detail: `mise shims not on PATH — bare commands (snyk/trivy/infisical/…) won't resolve. Add to your shell profile: ${activationLine(shims)}`,
    category: "tools",
  };
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
    const name = `${toolName} resolvable`;
    const category = "tools";

    // resolveToolBin is mise-first (`mise which`), so it finds tools installed via
    // `mise use -g` even when mise isn't activated and its shims aren't on PATH —
    // before falling back to a system PATH lookup.
    const bin = await resolveToolBin(toolName);
    if (bin) {
      checks.push({ name, status: "pass", detail: bin, category });
    } else {
      checks.push({
        name,
        status: "warn",
        detail: "not found (run: kit install)",
        category,
      });
    }
  }

  return checks;
}

async function checkKitWrapper(): Promise<DoctorCheck | null> {
  const { kitWrapperPath, WRAPPER_MARKER } = await import("./kit-wrapper.js");
  const path = kitWrapperPath();
  const name = "hook wrapper";
  const category = "hooks";
  try {
    await access(path);
  } catch {
    return {
      name,
      status: "warn",
      detail: `${path} missing — hooks may fail in a non-login shell. Run: kit memory install`,
      category,
    };
  }
  const content = await readFile(path, "utf-8").catch(() => "");
  if (!content.includes(WRAPPER_MARKER)) {
    return { name, status: "warn", detail: `${path} exists but is not kit-managed`, category };
  }
  return { name, status: "pass", detail: path, category };
}

async function checkMemoryHooks(): Promise<DoctorCheck | null> {
  const { memoryHooksLiveness } = await import("./memory/install.js");
  const name = "memory hooks";
  const category = "hooks";
  const live = memoryHooksLiveness();
  if (!live.everInstalled) return null; // never installed here → nothing to verify
  if (live.missing.length === 0) {
    return { name, status: "pass", detail: `${live.present.length} wired`, category };
  }
  // Installed once, but a hook has since vanished — capture is silently off.
  return {
    name,
    status: "fail",
    detail: `installed but missing from settings.json: ${live.missing.join(", ")} — memory capture is silently off. Run: kit memory install`,
    category,
  };
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

/**
 * Identity KeyStore posture (Pelare 1). Surfaces WHICH backend signs kit's
 * identity and — per the North Star design principle — makes any degradation to
 * the file-backed 0600 key HONEST rather than silent:
 *   pass  hardware-rooted (Secure Enclave / TPM / external command)
 *   warn  file-backed 0600 key (the working default; no hardware backend active)
 *   fail  hardware REQUIRED (KIT_REQUIRE_HARDWARE / policy) but unavailable —
 *         fail-closed, the same posture keystoreSign enforces at sign time.
 */
function checkIdentityKeystore(): DoctorCheck {
  const name = "identity keystore";
  const category = "security";
  const st = activeKeyStoreStatus();
  const required = hardwareRequired();

  if (required && !st.hardwareRooted) {
    return {
      name,
      status: "fail",
      detail: `hardware identity required but unavailable — ${st.reason ?? "no hardware backend"} (signing is fail-closed)`,
      category,
    };
  }
  if (st.hardwareRooted && st.available) {
    return {
      name,
      status: "pass",
      detail: `hardware-rooted: ${st.kind}${st.kid ? ` (${st.kid})` : ""}`,
      category,
    };
  }
  // File-backed default — accepted, but surfaced (never silent).
  return {
    name,
    status: "warn",
    detail: `file-backed key (0600)${st.kid ? ` (${st.kid})` : ""} — no hardware backend active; migrate with 'kit identity' or require one via KIT_REQUIRE_HARDWARE`,
    category,
  };
}

export async function runDoctor(config: kitConfig, cwd: string): Promise<DoctorResult> {
  const allChecks: DoctorCheck[] = [];

  allChecks.push(await checkNodeVersion(cwd));
  allChecks.push(await checkMise());

  const misePathCheck = await checkMisePath();
  if (misePathCheck) allChecks.push(misePathCheck);

  const envLocalCheck = await checkEnvLocal(config, cwd);
  if (envLocalCheck) allChecks.push(envLocalCheck);

  const toolsInPathChecks = await checkToolsInPath(config);
  allChecks.push(...toolsInPathChecks);

  const hookChecks = await checkGitHooks(config);
  allChecks.push(...hookChecks);

  const wrapperCheck = await checkKitWrapper();
  if (wrapperCheck) allChecks.push(wrapperCheck);

  const memoryHooksCheck = await checkMemoryHooks();
  if (memoryHooksCheck) allChecks.push(memoryHooksCheck);

  allChecks.push(checkIdentityKeystore());

  const passed = allChecks.filter((c) => c.status === "pass").length;
  const warnings = allChecks.filter((c) => c.status === "warn").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;

  return { checks: allChecks, passed, warnings, failed };
}
