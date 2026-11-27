/**
 * Install-gate wiring for the agents whose hook contract is not Claude Code's: Gemini CLI,
 * OpenCode, Cline and Antigravity. Each installer cites the agent source it follows.
 */
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { kitGateInvocation } from "./kit-invocation.js";
import {
  detectOpenCodeVersion,
  isV1OnlyPlugin,
  openCodePluginApi,
  renderOpenCodeInstallGate,
} from "./opencode-gate.js";
import type { HookInstallResult } from "./agent-config.js";

interface SettingsHookCmd {
  type?: string;
  command: string;
}
interface SettingsHookGroup {
  matcher?: string;
  hooks?: SettingsHookCmd[];
}

/**
 * Gemini CLI runs no settings hook in an untrusted folder, user-level hooks included
 * (google-gemini/gemini-cli `packages/core/src/hooks/hookRegistry.ts:171-186`, commit 60f8082b), and
 * folder trust is on by default (`packages/cli/src/config/settingsSchema.ts`, `folderTrust.enabled`).
 * `/permissions trust` (`packages/cli/src/ui/commands/permissionsCommand.ts:23-30`) records the
 * folder in `~/.gemini/trustedFolders.json`.
 */
export const GEMINI_TRUST_NOTICE =
  "Gemini CLI runs this gate only in a trusted folder. In Gemini CLI, run `/permissions trust` in this folder (it is saved in ~/.gemini/trustedFolders.json).";

/**
 * Gemini CLI install-gate: a `BeforeTool` hook in `.gemini/settings.json` (same
 * nested hooks > Event > matcher > hooks[] shape as Claude Code). Gemini passes
 * the command in tool_input.command. When a hook prints JSON, the JSON decides and the
 * exit code is ignored (`packages/core/src/hooks/hookRunner.ts:451-489`), so the gate runs
 * with `--format gemini`: a stdout `{"decision":"deny"}` plus stderr and exit 2. An older kit
 * hook line is refreshed in place. Idempotent; preserves other settings/hooks.
 */
export async function installInstallGateGemini(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".gemini/settings.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".gemini"))) {
    return { file, action: "skipped", detail: "no Gemini CLI project detected" };
  }
  const notice = GEMINI_TRUST_NOTICE;
  let settings: { hooks?: Record<string, SettingsHookGroup[]>; [k: string]: unknown } = {};
  let existed = false;
  try {
    settings = JSON.parse(await readFile(path, "utf-8")) as typeof settings;
    existed = true;
  } catch {
    settings = {};
  }
  const hooks = (settings.hooks ??= {});
  const pre = (hooks.BeforeTool ??= []);
  const desired = `${kitGateInvocation()} --format gemini`;
  const kitHook = pre.flatMap((g) => g.hooks ?? []).find((h) => h.command?.includes("gate-bash"));
  if (kitHook?.command === desired) {
    return { file, action: "unchanged", detail: "install-gate already wired", notice };
  }
  if (kitHook) kitHook.command = desired;
  else pre.push({ matcher: "", hooks: [{ type: "command", command: desired }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created", notice };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function readOpenCodePlugin(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error("OpenCode gate path is not a file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeOpenCodePlugin(path: string, content: string, replace: boolean): Promise<void> {
  if (!replace) {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${path}.kit-tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * OpenCode install-gate: unlike the other agents (which register a hook *command*
 * in a config file), OpenCode enforces via a JS **plugin** that blocks a tool call by
 * throwing. We write one managed plugin to `.opencode/plugin/kit-install-gate.js`. No single file
 * loads in every OpenCode release (opencode-gate.ts has the loader evidence), so the installed
 * OpenCode version picks the form: 1.0 to 1.3 get the function-only V1 plugin, 1.4 and later
 * (2.x included) the plugin with a default object. When the version cannot be read, a new install
 * gets the 1.4+ form, and a V1 plugin that kit wrote earlier is kept, because it may be the one
 * that works. Exact current output is idempotent; an independently managed gate is never
 * overwritten.
 */
export async function installInstallGateOpenCode(
  cwd: string = process.cwd(),
  version: (projectRoot: string) => string | undefined = detectOpenCodeVersion,
): Promise<HookInstallResult> {
  const file = ".opencode/plugin/kit-install-gate.js";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  const markers = [".opencode", "opencode.json", "opencode.jsonc"];
  if (!markers.some((m) => existsSync(resolve(cwd, m)))) {
    return { file, action: "skipped", detail: "no OpenCode project detected" };
  }
  const current = await readExistingOpenCodePlugin(path, file);
  if (typeof current !== "string" && current !== undefined) return current;
  return writeOpenCodeGate(path, file, current, openCodePluginApi(version(cwd)));
}

/** Write the plugin form for `api`; an unknown version keeps a 1.x plugin kit wrote before. */
async function writeOpenCodeGate(
  path: string,
  file: string,
  current: string | undefined,
  api: ReturnType<typeof openCodePluginApi>,
): Promise<HookInstallResult> {
  if (api === undefined && current !== undefined && isV1OnlyPlugin(current)) {
    const detail = "kept the OpenCode 1.x plugin";
    return { file, action: "unchanged", detail, notice: OPENCODE_UNKNOWN_KEEP };
  }
  const plugin = renderOpenCodeInstallGate(api ?? "both");
  const notice = api === undefined ? OPENCODE_UNKNOWN_NEW : undefined;
  if (current === plugin) {
    return { file, action: "unchanged", detail: "install-gate already wired", notice };
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeOpenCodePlugin(path, plugin, current !== undefined);
    return { file, action: current !== undefined ? "updated" : "created", notice };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

const OPENCODE_UNKNOWN_KEEP =
  "kit could not read the OpenCode version, so it kept the OpenCode 1.x gate plugin. OpenCode 2.x does not load that plugin: put `opencode` on PATH and run kit agent-config again.";
const OPENCODE_UNKNOWN_NEW =
  "kit could not read the OpenCode version. The gate plugin loads in OpenCode 1.4 and later; OpenCode 1.0 to 1.3 do not load it.";

/**
 * The kit-managed plugin text at `path`; undefined when there is none. A result object when kit
 * must not write there: a symlink, an external file, or a read error.
 */
async function readExistingOpenCodePlugin(
  path: string,
  file: string,
): Promise<string | undefined | HookInstallResult> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { file, action: "skipped", detail: "external or symlinked path; refusing overwrite" };
    }
    const current = await readOpenCodePlugin(path);
    if (current.includes("Generated by `kit agent-config --install-gate`")) return current;
    return current.includes("gate-bash")
      ? { file, action: "unchanged", detail: "external install-gate already wired" }
      : { file, action: "skipped", detail: "external file exists; refusing overwrite" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cline install-gate: Cline discovers an EXECUTABLE script named exactly the
 * event (`PreToolUse`, no extension) under `.clinerules/hooks/` and runs it as a
 * subprocess, feeding the tool call as JSON on stdin. Unlike the exit-2 agents
 * and OpenCode's plugin-throw, Cline blocks via a **stdout JSON** contract
 * (`{cancel:true,errorMessage}` — `HookOutputSchema`). Verified against
 * @cline/core (`HookConfigFileName.PreToolUse`, `HOOKS_CONFIG_DIRECTORY_NAME`)
 * and @cline/shared (`PreToolUseData {toolName, parameters}`, payload nested
 * under `preToolUse`). We write a tiny sh shim that execs `kit gate-bash
 * --format cline`, which reads that payload and emits the cancel-JSON.
 */
export async function installInstallGateCline(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".clinerules/hooks/PreToolUse";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".clinerules")) && !existsSync(resolve(cwd, ".cline"))) {
    return { file, action: "skipped", detail: "no Cline project detected" };
  }

  const existed = existsSync(path);
  if (existed) {
    try {
      if ((await readFile(path, "utf-8")).includes("gate-bash")) {
        return { file, action: "unchanged", detail: "install-gate already wired" };
      }
    } catch {
      // unreadable → overwrite below
    }
  }

  const script = `#!/bin/sh
# kit install-gate (Cline PreToolUse hook). Generated by \`kit agent-config
# --install-gate\`. Delete this file to disable. Reads the tool call on stdin and
# blocks an un-triaged install via the {cancel:true} stdout contract.
exec ${kitGateInvocation()} --format cline
`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, script, { encoding: "utf-8", mode: 0o755 });
    const { chmod } = await import("node:fs/promises");
    await chmod(path, 0o755).catch(() => {}); // ensure +x even when overwriting; no-op on non-POSIX
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The name of kit's hook in Antigravity's `hooks.json`, whose top-level keys are hook names. */
export const ANTIGRAVITY_HOOK_NAME = "kit-install-gate";

interface AntigravityHook {
  enabled?: boolean;
  [event: string]: unknown;
}

/** True when a hook group runs kit's gate. */
function runsKitGate(group: SettingsHookGroup): boolean {
  return (group.hooks ?? []).some(
    (h) => typeof h.command === "string" && h.command.includes("gate-bash"),
  );
}

/**
 * Move kit's gate out of the `{"hooks": {...}}` shape older kit versions wrote. Antigravity reads
 * that as one hook named `hooks`, so the user's other groups in it keep running there; only kit's
 * group leaves, and the `hooks` key goes when nothing else is left in it. Returns true on a change.
 */
function migrateLegacyAntigravity(config: Record<string, unknown>): boolean {
  const legacy = config.hooks;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return false;
  const events = legacy as Record<string, unknown>;
  const pre = events.PreToolUse;
  if (!Array.isArray(pre)) return false;
  const kept = (pre as SettingsHookGroup[]).filter((g) => !runsKitGate(g));
  if (kept.length === pre.length) return false;
  if (kept.length > 0) events.PreToolUse = kept;
  else delete events.PreToolUse;
  const rest = Object.keys(events).filter((k) => k !== "enabled");
  if (rest.length === 0) delete config.hooks;
  return true;
}

/** Read `.agents/hooks.json`: an object, or nothing yet. Never overwrites what it cannot parse. */
async function readAntigravityConfig(
  path: string,
  file: string,
): Promise<{ config: Record<string, unknown>; existed: boolean } | HookInstallResult> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, existed: false };
    return { file, action: "failed", detail: `cannot read ${file}: ${String(err)}` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { config: parsed as Record<string, unknown>, existed: true };
    }
  } catch {
    /* reported below */
  }
  return { file, action: "failed", detail: `${file} is not a JSON object; refusing overwrite` };
}

/** kit's named Antigravity hook, enabled, with its gate line set to `desired`. */
function withKitAntigravityGate(
  current: AntigravityHook | undefined,
  groups: SettingsHookGroup[],
  kitHook: SettingsHookCmd | undefined,
  desired: string,
): AntigravityHook {
  if (kitHook && current) {
    kitHook.command = desired;
    return { ...current, enabled: true };
  }
  return {
    ...(current ?? {}),
    enabled: true,
    PreToolUse: [
      ...groups,
      { matcher: "run_command", hooks: [{ type: "command", command: desired, timeout: 30 }] },
    ],
  };
}

/**
 * Google Antigravity install-gate: a `PreToolUse` hook in the workspace-scoped
 * `.agents/hooks.json` (preferred over the global ~/.gemini/config/hooks.json to
 * keep kit's per-project pattern). The file's top-level keys are hook names:
 * `{"kit-install-gate": {"enabled": true, "PreToolUse": [{"matcher": "run_command", "hooks": [...]}]}}`
 * (https://antigravity.google/docs/hooks.md, fetched 2026-11-26; Antigravity is closed source).
 * Antigravity carries the command at `toolCall.args.CommandLine` and reads a required stdout
 * `decision`; its exit-code meaning is not documented, so `--format antigravity` writes the
 * decision and also exits 2 on a deny. Migrates kit's older `{"hooks": {...}}` entry without
 * dropping the user's hooks. Idempotent. Detected via a repo `.agents/` dir.
 */
export async function installInstallGateAntigravity(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".agents/hooks.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".agents"))) {
    return { file, action: "skipped", detail: "no Antigravity (.agents/) project detected" };
  }
  const read = await readAntigravityConfig(path, file);
  if ("action" in read) return read;
  const { config, existed } = read;
  const migrated = migrateLegacyAntigravity(config);
  const desired = `${kitGateInvocation()} --format antigravity`;
  const current = config[ANTIGRAVITY_HOOK_NAME] as AntigravityHook | undefined;
  const groups = Array.isArray(current?.PreToolUse)
    ? (current.PreToolUse as SettingsHookGroup[])
    : [];
  const kitHook = groups
    .flatMap((g) => g.hooks ?? [])
    .find((h) => h.command?.includes("gate-bash"));
  if (!migrated && current?.enabled !== false && kitHook?.command === desired) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  config[ANTIGRAVITY_HOOK_NAME] = withKitAntigravityGate(current, groups, kitHook, desired);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
