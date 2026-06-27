import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/**
 * Teach the coding agent to use kit.
 *
 * `kit setup` only writes `.kit.toml` — it does not tell Claude Code / Codex /
 * Cursor / Cline to actually *run* kit. This module injects a small, managed
 * instruction block into the agent's rules file so the agent runs `kit check`,
 * triages dependencies before install, and resolves secrets via the vault.
 *
 * Safety: this only writes plain text the agent reads — it never registers an
 * executable hook (that's a separate, more invasive opt-in). The block is
 * delimited by BEGIN/END markers and is idempotent: re-running updates the
 * block in place and never touches anything outside the markers.
 */

export const KIT_BLOCK_BEGIN =
  "<!-- BEGIN kit (managed block — edit outside the markers, not inside) -->";
export const KIT_BLOCK_END = "<!-- END kit -->";

/** The canonical "use kit" instruction. Kept short on purpose — agents read it
 *  every turn, so it states the rules, not the rationale. */
export const KIT_INSTRUCTION = `## kit

This project uses [kit](https://github.com/sandstream/kit) to manage tools, secrets, and environment setup. As the agent working here:

- At session start run \`kit statusline\` and surface it — it shows the setup score for the active mode, whether a kit update is available, and the open "blocked-on-you" (PAL) count.
- Run \`kit check\` before starting; if it reports \`fail\`, run \`kit fix\` then re-check.
- Recall prior decisions with \`kit memory search "<query>"\` (cross-session, cross-agent); keep the local store current with \`kit memory index\`.
- Before installing ANY dependency, run \`kit triage npm|pip|docker|repo <target>\` and only install if it passes.
- Never write secrets to \`.env*\` in plaintext — resolve them with \`kit secrets\` (vault-backed).
- After a batch of edits, run \`kit check --category security\`; halt and surface findings on \`fail\`.
- Destructive secret ops require \`kit auth elevate\` first.`;

export interface AgentTarget {
  /** Agent/tool name for display. */
  agent: string;
  /** Rules file, relative to project root. */
  file: string;
}

/** Rules file per agent. CLAUDE.md / AGENTS.md are the common cross-tool ones;
 *  Cursor and Cline read their own dotfiles. */
export const AGENT_TARGETS: AgentTarget[] = [
  { agent: "Claude Code", file: "CLAUDE.md" },
  { agent: "Codex", file: "AGENTS.md" },
  { agent: "Cursor", file: ".cursorrules" },
  { agent: "Cline", file: ".clinerules" },
];

/**
 * Which agents look present in this project. Presence = the rules file already
 * exists OR a tool-specific marker dir/file is there. When nothing matches we
 * fall back to the two portable defaults (CLAUDE.md + AGENTS.md) so a fresh
 * project still gets wired.
 */
export function detectAgentTargets(cwd: string = process.cwd()): AgentTarget[] {
  const present = AGENT_TARGETS.filter((t) => {
    if (existsSync(resolve(cwd, t.file))) return true;
    switch (t.agent) {
      case "Claude Code":
        return existsSync(resolve(cwd, ".claude"));
      case "Codex":
        // AGENTS.md is the shared cross-tool rules file: Codex AND OpenCode both
        // read it, so an OpenCode-only project (opencode.json / .opencode, no
        // .codex) should still wire its block into AGENTS.md.
        return (
          existsSync(resolve(cwd, ".codex")) ||
          existsSync(resolve(cwd, ".opencode")) ||
          existsSync(resolve(cwd, "opencode.json")) ||
          existsSync(resolve(cwd, "opencode.jsonc"))
        );
      case "Cursor":
        return existsSync(resolve(cwd, ".cursor"));
      default:
        return false;
    }
  });
  if (present.length > 0) return present;
  return AGENT_TARGETS.filter((t) => t.file === "CLAUDE.md" || t.file === "AGENTS.md");
}

/**
 * Insert or update the managed kit block in `content`. Pure string transform —
 * no I/O — so it's trivially testable.
 *
 * - No existing block → append (with a blank-line separator if the file is non-empty).
 * - Existing block → replace just the marker-delimited region, preserving everything else.
 */
export function upsertKitBlock(content: string): {
  next: string;
  action: "created" | "updated" | "unchanged";
} {
  const block = `${KIT_BLOCK_BEGIN}\n\n${KIT_INSTRUCTION}\n\n${KIT_BLOCK_END}`;
  const begin = content.indexOf(KIT_BLOCK_BEGIN);
  const end = content.indexOf(KIT_BLOCK_END);

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = content.slice(0, begin);
    const after = content.slice(end + KIT_BLOCK_END.length);
    const next = before + block + after;
    return { next, action: next === content ? "unchanged" : "updated" };
  }

  const sep =
    content.length === 0
      ? ""
      : content.endsWith("\n\n")
        ? ""
        : content.endsWith("\n")
          ? "\n"
          : "\n\n";
  return { next: content + sep + block + "\n", action: "created" };
}

export interface AgentConfigResult {
  agent: string;
  file: string;
  action: "created" | "updated" | "unchanged" | "failed";
  detail: string;
}

/**
 * Write the managed kit block into each detected agent's rules file.
 * Read-only mode refuses + audits before any write.
 */
export async function writeAgentConfig(
  cwd: string = process.cwd(),
  targets?: AgentTarget[],
): Promise<AgentConfigResult[]> {
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("write-agent-config", {});
    return [{ agent: "all", file: "-", action: "failed", detail: refusal.reason }];
  }

  const chosen = targets ?? detectAgentTargets(cwd);
  const results: AgentConfigResult[] = [];

  for (const t of chosen) {
    const path = resolve(cwd, t.file);
    let existing = "";
    try {
      existing = await readFile(path, "utf-8");
    } catch {
      existing = ""; // file absent — will be created
    }
    try {
      const { next, action } = upsertKitBlock(existing);
      if (action === "unchanged") {
        results.push({ agent: t.agent, file: t.file, action, detail: "kit block already current" });
        continue;
      }
      await writeFile(path, next, "utf-8");
      results.push({
        agent: t.agent,
        file: t.file,
        action,
        detail:
          action === "created" ? `wrote kit block to ${t.file}` : `updated kit block in ${t.file}`,
      });
    } catch (err) {
      results.push({
        agent: t.agent,
        file: t.file,
        action: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * The READ-ONLY kit commands an agent should be allowed to run without a
 * permission prompt. Teaching the agent to "use kit" is useless if every
 * `kit …` hits the permission wall in auto/non-interactive mode and the agent
 * silently never runs it. These are all non-mutating: no `secrets`, `fix`,
 * `hooks add`, `agent-config`, `context use`, or `memory install` — those keep
 * prompting on purpose. We never write a `deny` rule or a bypass mode.
 */
export const READONLY_KIT_PERMISSIONS: string[] = [
  "Bash(kit check:*)",
  "Bash(kit status:*)",
  "Bash(kit doctor:*)",
  "Bash(kit ci:*)",
  "Bash(kit analyze:*)",
  "Bash(kit escalate:*)",
  "Bash(kit context check:*)",
  "Bash(kit triage:*)",
  "Bash(kit memory search:*)",
  "Bash(kit memory stats:*)",
  "Bash(kit memory index:*)",
];

export interface PermissionResult {
  file: string;
  added: string[];
  alreadyPresent: number;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  detail?: string;
}

/**
 * Grant the agent permission to run kit's read-only commands by merging
 * allow-rules into the project's `.claude/settings.json`. Idempotent and
 * non-destructive: preserves the user's other allow rules, never touches
 * `deny`, never sets a permission mode. Only wired for Claude Code (the agent
 * whose settings schema we know).
 */
export async function installKitPermissions(
  cwd: string = process.cwd(),
): Promise<PermissionResult> {
  const file = ".claude/settings.json";
  const path = resolve(cwd, file);

  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    return { file, added: [], alreadyPresent: 0, action: "skipped", detail: "read-only mode" };
  }
  // Only meaningful in a Claude Code project.
  if (!existsSync(resolve(cwd, ".claude")) && !existsSync(resolve(cwd, "CLAUDE.md"))) {
    return {
      file,
      added: [],
      alreadyPresent: 0,
      action: "skipped",
      detail: "no Claude Code project detected",
    };
  }

  let settings: { permissions?: { allow?: string[] }; [k: string]: unknown } = {};
  let existed = false;
  try {
    settings = JSON.parse(await readFile(path, "utf-8")) as typeof settings;
    existed = true;
  } catch {
    settings = {}; // absent or unreadable → start fresh (preserve nothing we can't parse)
  }

  const perms = (settings.permissions ??= {});
  const allow = (perms.allow ??= []);
  const added: string[] = [];
  let alreadyPresent = 0;
  for (const rule of READONLY_KIT_PERMISSIONS) {
    if (allow.includes(rule)) {
      alreadyPresent++;
      continue;
    }
    allow.push(rule);
    added.push(rule);
  }

  if (added.length === 0) {
    return { file, added, alreadyPresent, action: "unchanged" };
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, added, alreadyPresent, action: existed ? "updated" : "created" };
  } catch (err) {
    return {
      file,
      added: [],
      alreadyPresent,
      action: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Absolute `<node> <cli.js> gate-bash` for use inside a hook (PATH-less shell). */
export function kitGateInvocation(): string {
  const entry = process.argv[1];
  if (entry) return `${process.execPath} ${resolve(entry)} gate-bash`;
  return "kit gate-bash"; // last resort — relies on PATH
}

export interface HookInstallResult {
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  detail?: string;
}

interface SettingsHookCmd {
  type?: string;
  command: string;
}
interface SettingsHookGroup {
  matcher?: string;
  hooks?: SettingsHookCmd[];
}

/**
 * Install the PreToolUse install-gate hook into `.claude/settings.json` so an
 * un-triaged package install is BLOCKED before it runs — the *enforce* layer for
 * agent auto-mode (the rules-file block only *advises*; an agent can otherwise run
 * `npm install evil` directly and its postinstall fires before any commit). Opt-in
 * and idempotent (keyed on a hook command ending in `gate-bash`); preserves any
 * other hooks. Only wired for Claude Code today (the settings schema we know).
 */
export async function installInstallGate(cwd: string = process.cwd()): Promise<HookInstallResult> {
  const file = ".claude/settings.json";
  const path = resolve(cwd, file);

  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".claude")) && !existsSync(resolve(cwd, "CLAUDE.md"))) {
    return { file, action: "skipped", detail: "no Claude Code project detected" };
  }

  let settings: { hooks?: Record<string, SettingsHookGroup[]>; [k: string]: unknown } = {};
  let existed = false;
  try {
    settings = JSON.parse(await readFile(path, "utf-8")) as typeof settings;
    existed = true;
  } catch {
    settings = {};
  }

  const hooks = (settings.hooks ??= {});
  const pre = (hooks.PreToolUse ??= []);
  const already = pre.some((g) => g.hooks?.some((h) => h.command?.endsWith("gate-bash")));
  if (already) return { file, action: "unchanged", detail: "install-gate already wired" };

  pre.push({ matcher: "Bash", hooks: [{ type: "command", command: kitGateInvocation() }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Codex install-gate: a `[[hooks.PreToolUse]]` block in `.codex/config.toml`
 * (matcher `^Bash$`) that runs `kit gate-bash` and exits 2 to block. We APPEND
 * the TOML block as text rather than parse→stringify, so the user's existing
 * config + comments are preserved; idempotent via a `gate-bash` text check.
 */
export async function installInstallGateCodex(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".codex/config.toml";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".codex")) && !existsSync(resolve(cwd, "AGENTS.md"))) {
    return { file, action: "skipped", detail: "no Codex project detected" };
  }

  let existing = "";
  let existed = false;
  try {
    existing = await readFile(path, "utf-8");
    existed = true;
  } catch {
    existing = "";
  }
  if (existing.includes("gate-bash")) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  // Single-quoted TOML literal — the invocation is an absolute node+path, no single quotes.
  const block = `\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '${kitGateInvocation()}'\n`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, existing + block, "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Amazon Q install-gate: add a `hooks.preToolUse` entry (matcher `execute_bash`)
 * to each agent config under `.amazonq/cli-agents/*.json`. Amazon Q keeps hooks
 * per-agent, so we wire every existing agent file; if none are present we skip
 * (honest about the per-agent layout rather than guessing a path). Idempotent.
 */
export async function installInstallGateAmazonQ(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const dir = ".amazonq/cli-agents";
  const dirPath = resolve(cwd, dir);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file: dir, action: "skipped", detail: "read-only mode" };
  let agentFiles: string[] = [];
  try {
    agentFiles = readdirSync(dirPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dirPath, f));
  } catch {
    agentFiles = [];
  }
  if (agentFiles.length === 0) {
    return { file: dir, action: "skipped", detail: "no Amazon Q agent config found" };
  }

  let wired = 0;
  let already = 0;
  for (const p of agentFiles) {
    let agent: {
      hooks?: Record<string, { matcher?: string; command: string }[]>;
      [k: string]: unknown;
    };
    try {
      agent = JSON.parse(await readFile(p, "utf-8"));
    } catch {
      continue; // skip unparseable agent file
    }
    const hooks = (agent.hooks ??= {});
    const pre = (hooks.preToolUse ??= []);
    if (pre.some((h) => typeof h?.command === "string" && h.command.endsWith("gate-bash"))) {
      already++;
      continue;
    }
    pre.push({ matcher: "execute_bash", command: kitGateInvocation() });
    try {
      await writeFile(p, JSON.stringify(agent, null, 2) + "\n", "utf-8");
      wired++;
    } catch {
      /* best-effort per file */
    }
  }
  if (wired === 0) {
    return {
      file: dir,
      action: "unchanged",
      detail: `install-gate already wired (${already} agent[s])`,
    };
  }
  return { file: dir, action: "updated", detail: `wired ${wired} Amazon Q agent config(s)` };
}

/**
 * Gemini CLI install-gate: a `BeforeTool` hook in `.gemini/settings.json` (same
 * nested hooks > Event > matcher > hooks[] shape as Claude Code). Gemini passes
 * the command in tool_input.command and blocks on exit 2 — so `kit gate-bash`
 * works unchanged. Idempotent; preserves other settings/hooks.
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
  if (pre.some((g) => g.hooks?.some((h) => h.command?.endsWith("gate-bash")))) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  pre.push({ matcher: "", hooks: [{ type: "command", command: kitGateInvocation() }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cursor install-gate: a `beforeShellExecution` hook in `.cursor/hooks.json`.
 * Cursor passes the shell command at top-level `command` and blocks on exit 2
 * (equivalent to returning `{permission:"deny"}`), so `kit gate-bash` works.
 * Idempotent; preserves other hooks.
 */
export async function installInstallGateCursor(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".cursor/hooks.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".cursor"))) {
    return { file, action: "skipped", detail: "no Cursor project detected" };
  }
  let cfg: {
    version?: number;
    hooks?: Record<string, { command: string }[]>;
    [k: string]: unknown;
  } = {};
  let existed = false;
  try {
    cfg = JSON.parse(await readFile(path, "utf-8")) as typeof cfg;
    existed = true;
  } catch {
    cfg = {};
  }
  cfg.version ??= 1;
  const hooks = (cfg.hooks ??= {});
  const pre = (hooks.beforeShellExecution ??= []);
  if (pre.some((h) => h.command?.endsWith("gate-bash"))) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  pre.push({ command: kitGateInvocation() });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The gate command as an argv array (`[node, cli.js, "gate-bash"]`) for execFileSync. */
export function kitGateArgv(): string[] {
  const entry = process.argv[1];
  if (entry) return [process.execPath, resolve(entry), "gate-bash"];
  return ["kit", "gate-bash"]; // last resort — relies on PATH
}

/**
 * OpenCode install-gate: unlike the other agents (which register a hook *command*
 * in a config file), OpenCode enforces via a JS **plugin** that hooks
 * `tool.execute.before` and BLOCKS by throwing — the verified contract from
 * `@opencode-ai/plugin` (opencode-ai@1.17.x). We write a small managed plugin to
 * `.opencode/plugin/kit-install-gate.js` that pipes the bash command into
 * `kit gate-bash` and throws when it exits non-zero (exit 2 = deny). Idempotent:
 * keyed on the generated file's presence. The args are embedded JSON-escaped so
 * node/cli paths with spaces survive.
 */
export async function installInstallGateOpenCode(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".opencode/plugin/kit-install-gate.js";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  const detected =
    existsSync(resolve(cwd, ".opencode")) ||
    existsSync(resolve(cwd, "opencode.json")) ||
    existsSync(resolve(cwd, "opencode.jsonc"));
  if (!detected) return { file, action: "skipped", detail: "no OpenCode project detected" };

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

  const plugin = `// kit install-gate — blocks un-triaged package installs before they run.
// Generated by \`kit agent-config --install-gate\`. Delete this file to disable.
import { execFileSync } from "node:child_process";

const GATE = ${JSON.stringify(kitGateArgv())};

export const kitInstallGate = async () => ({
  "tool.execute.before": async (input, output) => {
    if ((input?.tool ?? "") !== "bash") return;
    const command = output?.args?.command;
    if (typeof command !== "string" || command === "") return;
    try {
      execFileSync(GATE[0], GATE.slice(1), {
        input: JSON.stringify({ tool_input: { command } }),
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (err) {
      // gate-bash exits 2 to deny — throw to block the tool call.
      const reason = err && err.stderr ? String(err.stderr).trim() : "untriaged install";
      throw new Error("kit install-gate blocked: " + reason);
    }
  },
});
`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, plugin, "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
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

/** Per-agent install-gate result. */
export interface GateInstallEntry {
  agent: "Claude Code" | "Codex" | "Amazon Q" | "Gemini CLI" | "Cursor" | "OpenCode" | "Cline";
  result: HookInstallResult;
}

/** Wire the PreToolUse install-gate for every supported agent present in the project. */
export async function installAllInstallGates(
  cwd: string = process.cwd(),
): Promise<GateInstallEntry[]> {
  return [
    { agent: "Claude Code", result: await installInstallGate(cwd) },
    { agent: "Codex", result: await installInstallGateCodex(cwd) },
    { agent: "Amazon Q", result: await installInstallGateAmazonQ(cwd) },
    { agent: "Gemini CLI", result: await installInstallGateGemini(cwd) },
    { agent: "Cursor", result: await installInstallGateCursor(cwd) },
    { agent: "OpenCode", result: await installInstallGateOpenCode(cwd) },
    { agent: "Cline", result: await installInstallGateCline(cwd) },
  ];
}
