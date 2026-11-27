import type { ToolConfig } from "./config.js";
import { checkTools, type ToolStatus } from "./check-tools.js";
import { gateInstall, type GateVerdict } from "./triage-gate.js";
import { resolveMiseVersion, type MiseVersion } from "./mise-version.js";
import { exec } from "./utils/exec.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstallResult {
  name: string;
  /** `blocked` = triage gate refused this install (watertight, fail-closed). */
  action: "installed" | "already_ok" | "failed" | "blocked";
  detail: string;
  /** Warnings from a triage that passed (cooling, no licence, very new). */
  warnings?: string[];
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

/**
 * The mise refs kit treats as security scanners — the DEFAULT set plus the two
 * conditionally-provisioned ones (trivy for containers/IaC, osv-scanner for
 * ecosystems without a dedicated scanner). Only these are auto-installed by the
 * `kit check` self-healing preflight, and only when the project ALREADY declares
 * them in `.kit.toml [tools]` — so the preflight can never pull in a tool the
 * project didn't opt into. Kept in sync with toml-generator's provisioning.
 */
const SCANNER_REFS = new Set<string>([
  "semgrep",
  "pipx:semgrep",
  "npm:@socketsecurity/cli",
  "aqua:trufflesecurity/trufflehog",
  "aqua:aquasecurity/trivy",
  "aqua:google/osv-scanner",
]);

export interface EnsureScannersOpts {
  /** Opt-out (KIT_CHECK_NO_AUTOINSTALL / --no-auto-install) — keep check read-only. */
  disabled?: boolean;
  /** Air-gapped posture → don't attempt a (possibly-blocked) network install; the
   *  enclave pre-provisions tools and the check fails closed if one is missing. */
  airGapped?: boolean;
}

/**
 * Self-healing preflight for `kit check` / `kit ci`: install any security scanner
 * that is DECLARED in `.kit.toml [tools]` but not yet present, so an ephemeral
 * environment actually RUNS the scan instead of reporting the scanner missing
 * (which now fails the strict gate). This is the runtime complement to `kit install`
 * at env-setup: setup provisions the scanners, and this backstops the case where
 * setup did not run. Only kit's known scanner refs are touched, only when already
 * declared, so it can never install a tool the project didn't opt into. Triage-gated
 * and read-only-aware via installTools; best-effort — a failure just leaves the
 * scanner missing and the check fails closed honestly. Returns the install results
 * (empty when skipped or nothing to do).
 */
export async function ensureScannersInstalled(
  tools: ToolConfig | undefined,
  opts: EnsureScannersOpts = {},
  deps: InstallDeps = defaultDeps,
): Promise<InstallResult[]> {
  if (opts.disabled || opts.airGapped || !tools) return [];
  const scanners: ToolConfig = {};
  for (const [ref, version] of Object.entries(tools)) {
    if (SCANNER_REFS.has(ref)) scanners[ref] = version;
  }
  if (Object.keys(scanners).length === 0) return [];
  return installTools(scanners, deps);
}

/** How `miseInstall` runs mise and finds the project. Injected so no test spawns mise. */
export interface MiseExecDeps {
  exec: (
    file: string,
    args: string[],
    opts: { timeout: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  cwd: () => string;
  home: () => string;
}

const defaultMiseExecDeps: MiseExecDeps = {
  exec: (file, args, opts) => exec(file, args, opts),
  cwd: () => process.cwd(),
  home: () => homedir(),
};

/**
 * The config file `mise use` writes, or null when the project folder is the home folder.
 *
 * Without `--global` or `--path`, `mise use` writes `mise.toml` in the current folder, "or global
 * config if cwd is home directory" (`mise help use`, mise v2026.6.11). kit ran it with neither, so a
 * run from `~` wrote the user's global `~/.config/mise/config.toml`. kit now always passes
 * `--path <file>` ("Specify a path to a config file or directory"), and refuses in the home
 * folder, where even `~/mise.toml` would apply to every project below it. An existing `.mise.toml`
 * is reused when there is no `mise.toml`, so kit does not create a second config beside it.
 */
export function miseUseTarget(cwd: string, home: string): string | null {
  if (sameIdentity(identityOf(cwd), identityOf(home))) return null;
  const plain = join(cwd, "mise.toml");
  const dotted = join(cwd, ".mise.toml");
  return !existsSync(plain) && existsSync(dotted) ? dotted : plain;
}

/** Backends whose `latest` mise resolves through a package manager kit must never let it run. */
const NO_LATEST_SCHEMES = /^(npm|pipx|pip):/i;

export async function miseInstall(
  tool: string,
  version: string,
  deps: MiseExecDeps = defaultMiseExecDeps,
): Promise<{ ok: boolean; detail: string }> {
  // Read-only mode: `mise install`/`mise use` mutate the toolchain. Refuse + audit.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("mise-install", { tool, version });
    return { ok: false, detail: refusal.reason };
  }
  // Defence in depth: installTools resolves `latest` first (mise-version.ts). A caller that
  // reaches this with `latest` for npm:/pipx: is refused, because mise would resolve it by running
  // `npm view` through its own shim, which recurses without bound.
  if (version.trim() === "latest" && NO_LATEST_SCHEMES.test(tool)) {
    return {
      ok: false,
      detail: `kit never hands "latest" to mise for ${tool}; resolve it to an exact version first`,
    };
  }
  const target = miseUseTarget(deps.cwd(), deps.home());
  if (!target) {
    return {
      ok: false,
      detail:
        "refusing to run `mise use` in the home folder: it would write the global mise config. Run kit from the project folder.",
    };
  }
  const spec = `${tool}@${version}`;
  try {
    await deps.exec("mise", ["install", spec], { timeout: 120_000, env: { ...process.env } });
    // Activate the tool in this project's config file only, never the global one.
    await deps.exec("mise", ["use", "--path", target, spec], {
      timeout: 30_000,
      env: { ...process.env },
    });
    return { ok: true, detail: `Installed ${spec} via mise (${target})` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof (err as { stderr?: unknown } | null)?.stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    return { ok: false, detail: miseErrorDetail(message, stderr) };
  }
}

/** A passing verdict's triage warnings, as a field to spread into its result. */
function warningsOf(verdict: GateVerdict | undefined): { warnings?: string[] } {
  return verdict?.warnings ? { warnings: verdict.warnings } : {};
}

export interface InstallDeps {
  checkTools: (tools: ToolConfig) => Promise<ToolStatus[]>;
  miseInstall: (tool: string, version: string) => Promise<{ ok: boolean; detail: string }>;
  gateInstall: (tool: string) => Promise<GateVerdict>;
  /** What version mise gets: `latest` becomes the newest cooled release, or a refusal. */
  resolveVersion: (tool: string, version: string) => Promise<MiseVersion>;
}

const defaultDeps: InstallDeps = {
  checkTools,
  miseInstall: (tool, version) => miseInstall(tool, version),
  gateInstall,
  resolveVersion: (tool, version) => resolveMiseVersion(tool, version),
};

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
  // Read-only mode: installing tools is a write. Refuse before any check/install
  // so the guard matches installHooks (no mutating sink bypasses --read-only).
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("install-tools", {
      tool_count: Object.keys(tools).length,
    });
    return [{ name: "read-only-refusal", action: "blocked", detail: refusal.reason }];
  }

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

    // `latest` is policy, not a version: resolve it to the newest cooled release, or refuse.
    // Never fall back to handing mise `latest` (mise-version.ts says why).
    const resolved = await deps.resolveVersion(status.name, status.required);
    if (resolved.kind === "refused") {
      results.push({ name: status.name, action: "failed", detail: resolved.reason });
      continue;
    }
    // Triage the exact version kit installs, not whatever the registry calls latest today.
    const gateRef =
      resolved.kind === "resolved" ? `${status.name}@${resolved.version}` : status.name;
    const verdict = opts.skipTriage ? undefined : await deps.gateInstall(gateRef);
    if (verdict?.decision === "blocked") {
      results.push({ name: status.name, action: "blocked", detail: verdict.reason });
      continue;
    }
    const warned = warningsOf(verdict);

    const { ok, detail } = await deps.miseInstall(status.name, resolved.version);
    if (!ok) {
      results.push({ name: status.name, action: "failed", detail, ...warned });
      continue;
    }

    // Re-check that installed version satisfies requirement
    const [verified] = await deps.checkTools({ [status.name]: status.required });
    if (verified.ok) {
      results.push({
        name: status.name,
        action: "installed",
        detail: `${verified.installed} satisfies ${status.required}`,
        ...warned,
      });
    } else {
      results.push({
        name: status.name,
        action: "failed",
        detail: `Installed ${verified.installed ?? "unknown"} but need ${status.required}`,
        ...warned,
      });
    }
  }

  return results;
}
