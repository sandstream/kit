import type { ToolConfig } from "./config.js";
import { checkTools, type ToolStatus } from "./check-tools.js";
import { gateInstall, type GateVerdict } from "./triage-gate.js";
import { exec } from "./utils/exec.js";


export interface InstallResult {
  name: string;
  /** `blocked` = triage gate refused this install (watertight, fail-closed). */
  action: "installed" | "already_ok" | "failed" | "blocked";
  detail: string;
}

/**
 * Turn a mise exec failure into an actionable message. PURE so it can be
 * unit-tested. `message` is the error's `.message` (often just the generic
 * "Command failed: mise install node@24"); `stderr` is mise's real output,
 * which carries the actionable cause. Common cases:
 *   - mise not installed at all (`spawn mise ENOENT`)
 *   - the repo's .mise.toml is untrusted (mise refuses to run until `mise trust`)
 * Otherwise prefer the real `mise ERROR` line from stderr over "Command failed".
 */
export function miseErrorDetail(message: string, stderr = ""): string {
  const firstMsg = message.split("\n")[0];
  if (/ENOENT/.test(firstMsg)) {
    return "mise is not installed — kit installs and pins tool versions with it. Install mise (brew install mise, or: curl https://mise.run | sh) and re-run, or install the tool yourself.";
  }
  const combined = `${message}\n${stderr}`;
  if (/not trusted|mise trust/i.test(combined)) {
    return "mise refused this repo's .mise.toml because it is not trusted. Review the file, then run `mise trust` here and re-run kit setup.";
  }
  // Prefer a concrete `mise ERROR ...` line over the generic "Command failed".
  const miseErr = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^mise ERROR/.test(l));
  if (miseErr) return miseErr.replace(/^mise ERROR\s*/, "");
  const firstStderr = stderr.trim().split("\n")[0];
  if (firstStderr) return firstStderr;
  return firstMsg;
}

async function miseInstall(
  tool: string,
  version: string,
): Promise<{ ok: boolean; detail: string }> {
  const versionArg = version === "latest" ? "latest" : version;
  try {
    await exec("mise", ["install", `${tool}@${versionArg}`], {
      timeout: 120_000,
      env: { ...process.env },
    });
    // Activate the tool in the current project
    await exec("mise", ["use", `${tool}@${versionArg}`], {
      timeout: 30_000,
      env: { ...process.env },
    });
    return { ok: true, detail: `Installed ${tool}@${versionArg} via mise` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof (err as { stderr?: unknown } | null)?.stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    return { ok: false, detail: miseErrorDetail(message, stderr) };
  }
}

export interface InstallDeps {
  checkTools: (tools: ToolConfig) => Promise<ToolStatus[]>;
  miseInstall: (tool: string, version: string) => Promise<{ ok: boolean; detail: string }>;
  gateInstall: (tool: string) => Promise<GateVerdict>;
}

const defaultDeps: InstallDeps = { checkTools, miseInstall, gateInstall };

/**
 * Install missing tools via mise. WATERTIGHT: every third-party tool is run
 * through the triage gate first; only a triage PASS (or a trusted core runtime)
 * is installed. A blocked tool is reported as `action: "blocked"` and never
 * touched. `opts.skipTriage` bypasses the gate and MUST only be set by a caller
 * that has consumed an elevation (the `--no-triage` override) — it is audit-
 * logged at the command layer.
 */
export async function installTools(
  tools: ToolConfig,
  deps: InstallDeps = defaultDeps,
  opts: { skipTriage?: boolean } = {},
): Promise<InstallResult[]> {
  const statuses = await deps.checkTools(tools);
  const results: InstallResult[] = [];

  for (const status of statuses) {
    if (status.ok) {
      results.push({
        name: status.name,
        action: "already_ok",
        detail: `${status.installed} satisfies ${status.required}`,
      });
      continue;
    }

    if (!opts.skipTriage) {
      const verdict = await deps.gateInstall(status.name);
      if (verdict.decision === "blocked") {
        results.push({ name: status.name, action: "blocked", detail: verdict.reason });
        continue;
      }
    }

    const { ok, detail } = await deps.miseInstall(status.name, status.required);
    if (!ok) {
      results.push({ name: status.name, action: "failed", detail });
      continue;
    }

    // Re-check that installed version satisfies requirement
    const [verified] = await deps.checkTools({ [status.name]: status.required });
    if (verified.ok) {
      results.push({
        name: status.name,
        action: "installed",
        detail: `${verified.installed} satisfies ${status.required}`,
      });
    } else {
      results.push({
        name: status.name,
        action: "failed",
        detail: `Installed ${verified.installed ?? "unknown"} but need ${status.required}`,
      });
    }
  }

  return results;
}
