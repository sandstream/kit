import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join, isAbsolute } from "node:path";

import { ensureKitWrapper, kitWrapperPath, WRAPPER_MARKER } from "./kit-wrapper.js";
import { shellSplit } from "./utils/shellSplit.js";
import type { kitConfig } from "./config.js";

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
export const USER_RULES_BLOCK_BEGIN = "<!-- BEGIN kit user rules (managed) -->";
export const USER_RULES_BLOCK_END = "<!-- END kit user rules -->";
export const USER_RULES_DEFAULT_MAX_LINES = 120;
export const USER_RULES_DEFAULT_MAX_BYTES = 12_000;

/** The canonical "use kit" instruction. Kept short on purpose — agents read it
 *  every turn, so it states the rules, not the rationale. Rules that have gained a
 *  DETERMINISTIC enforcement layer (hooks/gates) are stated as facts, not asks —
 *  prose only advises, so each rule migrates out of this block as its gate ships
 *  (statusline → session-start injection; triage → gate-bash; .env secrets →
 *  gate-env; elevation → enforced in the CLI itself). */
/**
 * The block kit writes into downstream projects' always-loaded instruction
 * files (CLAUDE.md / AGENTS.md / ...). Index, not encyclopedia: every request
 * pays for these tokens, so each line must survive the test "would removing it
 * cause mistakes?" — commands the agent cannot guess and would otherwise skip.
 * Everything a hook or the CLI itself enforces gets ZERO prose here (the gate
 * teaches the agent at exactly the moment it matters, deterministically) —
 * that's why the old hook-architecture paragraph and the `kit auth elevate`
 * line are gone. Discovery of the rest is `kit --help`, on demand, at zero
 * standing cost.
 */
export const KIT_INSTRUCTION = `## kit

This repo is managed by [kit](https://github.com/sandstream/kit) (env, secrets, security gates). Hooks enforce the hard rules; what you need to know:

- If \`kit\` is missing (fresh clone/machine): \`npm i -g sandstream-kit\`, then continue below.
- Start: \`kit check\` — on \`fail\`, run \`kit fix\`, then re-check.
- Prior decisions: \`kit memory search "<query>"\` (cross-session, cross-agent).
- Secrets: \`kit secrets\` (vault-backed); placeholders go in \`.env.example\`, never plaintext in \`.env*\`.
- Deploy env: \`[deploy]\` declares required platform key names; \`kit check --category deploy\` diffs remote names without reading values.
- Deps the install gate hasn't covered (git repos, URLs, vendored code): \`kit triage repo <target>\` first.
- After a batch of edits: \`kit check --category security\`; halt and surface findings on \`fail\`.
- Everything else: \`kit --help\` — the commands are self-documenting.`;

export interface UserRulesProfile {
  source: string;
  text: string;
  lineCount: number;
  byteCount: number;
  warnings: string[];
}

export interface UserRulesLoadResult {
  profile: UserRulesProfile | null;
  warnings: string[];
  error?: string;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\r\n/g, "\n").split("\n").length;
}

function userRulesLooksGateable(text: string): number {
  const gateWords =
    /\b(must|never|always|required|forbid|forbidden|require|shall)\b|\b(ska|måste|alltid|aldrig|förbjud)\b/i;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => gateWords.test(line)).length;
}

async function readUserRulesSource(source: string, cwd: string): Promise<string> {
  const expanded = expandHomePath(source);
  const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const info = await stat(path);
  if (!info.isDirectory()) return readFile(path, "utf-8");

  const entries = await readdir(path, { withFileTypes: true });
  const mdFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const parts: string[] = [];
  for (const name of mdFiles) {
    const body = (await readFile(join(path, name), "utf-8")).trim();
    if (body) parts.push(body);
  }
  return parts.join("\n\n");
}

export async function loadUserRulesProfile(
  config: kitConfig | undefined,
  cwd: string = process.cwd(),
): Promise<UserRulesLoadResult> {
  const cfg = config?.agent_config?.user_rules;
  if (!cfg?.enabled) return { profile: null, warnings: [] };
  if (!cfg.source) {
    return {
      profile: null,
      warnings: [],
      error: "[agent_config.user_rules] enabled=true requires source",
    };
  }

  let text: string;
  try {
    text = (await readUserRulesSource(cfg.source, cwd)).trim();
  } catch (err) {
    return {
      profile: null,
      warnings: [],
      error: `could not read user rules source ${cfg.source}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const lineCount = countLines(text);
  const byteCount = Buffer.byteLength(text, "utf-8");
  const maxLines = cfg.max_lines ?? USER_RULES_DEFAULT_MAX_LINES;
  const maxBytes = cfg.max_bytes ?? USER_RULES_DEFAULT_MAX_BYTES;
  if (lineCount > maxLines || byteCount > maxBytes) {
    return {
      profile: null,
      warnings: [],
      error: `user rules source ${cfg.source} is too large (${lineCount} line(s), ${byteCount} byte(s); max ${maxLines} line(s), ${maxBytes} byte(s))`,
    };
  }

  const warnings: string[] = [];
  const gateable = userRulesLooksGateable(text);
  if (gateable > 0) {
    warnings.push(
      `${cfg.source} has ${gateable} gate-like line(s); deterministic house rules belong in .kit/standards.d when possible.`,
    );
  }

  return {
    profile: { source: cfg.source, text, lineCount, byteCount, warnings },
    warnings,
  };
}

export function buildKitInstruction(userRules?: UserRulesProfile | null): string {
  if (!userRules?.text) return KIT_INSTRUCTION;
  return `${KIT_INSTRUCTION}

${USER_RULES_BLOCK_BEGIN}

## Personal Profile

${userRules.text}

${USER_RULES_BLOCK_END}`;
}

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
  { agent: "Copilot", file: ".github/copilot-instructions.md" },
  // Gemini CLI reads GEMINI.md — kit already indexes/gates Gemini but never wrote
  // its rules file (only status-checked it), so this closes that gap.
  { agent: "Gemini CLI", file: "GEMINI.md" },
  // Augment reads a root .augment-guidelines file (applies to all Agent/Chat sessions).
  { agent: "Augment", file: ".augment-guidelines" },
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
        // AGENTS.md is the Linux-Foundation cross-tool standard: Codex, OpenCode,
        // Factory Droid (.factory), AWS Kiro (.kiro) and Kilo Code (.kilocode/.kilo/
        // kilo.jsonc — reads AGENTS.md primary, CLAUDE.md compat) all consume it,
        // so any of their marker dirs should wire the block into AGENTS.md.
        return (
          existsSync(resolve(cwd, ".codex")) ||
          existsSync(resolve(cwd, ".opencode")) ||
          existsSync(resolve(cwd, "opencode.json")) ||
          existsSync(resolve(cwd, "opencode.jsonc")) ||
          existsSync(resolve(cwd, ".kiro")) ||
          existsSync(resolve(cwd, ".factory")) ||
          existsSync(resolve(cwd, ".kilocode")) ||
          existsSync(resolve(cwd, ".kilo")) ||
          existsSync(resolve(cwd, "kilo.jsonc"))
        );
      case "Cursor":
        return existsSync(resolve(cwd, ".cursor"));
      case "Gemini CLI":
        return existsSync(resolve(cwd, ".gemini"));
      case "Augment":
        return existsSync(resolve(cwd, ".augment"));
      case "Copilot":
        // GitHub Copilot (VS Code / Visual Studio) reads
        // `.github/copilot-instructions.md`. The file check above covers an
        // existing one; a `.vscode/` dir marks a VS Code project where Copilot
        // is the likely agent, so wire it there too.
        return existsSync(resolve(cwd, ".vscode"));
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
export function upsertKitBlock(
  content: string,
  userRules?: UserRulesProfile | null,
): {
  next: string;
  action: "created" | "updated" | "unchanged";
} {
  const block = `${KIT_BLOCK_BEGIN}\n\n${buildKitInstruction(userRules)}\n\n${KIT_BLOCK_END}`;
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

export interface WriteAgentConfigOptions {
  userRules?: UserRulesProfile | null;
}

/**
 * Write the managed kit block into each detected agent's rules file.
 * Read-only mode refuses + audits before any write.
 */
export async function writeAgentConfig(
  cwd: string = process.cwd(),
  targets?: AgentTarget[],
  opts: WriteAgentConfigOptions = {},
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
    let existing: string;
    try {
      existing = await readFile(path, "utf-8");
    } catch {
      existing = ""; // file absent — will be created
    }
    try {
      const { next, action } = upsertKitBlock(existing, opts.userRules);
      if (action === "unchanged") {
        results.push({ agent: t.agent, file: t.file, action, detail: "kit block already current" });
        continue;
      }
      // Rules files can be nested (e.g. Copilot's `.github/copilot-instructions.md`);
      // create the parent dir. No-op for root-level targets.
      await mkdir(dirname(path), { recursive: true });
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
 * Merge `CONVENTIONS.md` into an `.aider.conf.yml` `read:` directive without a
 * YAML dependency. Idempotent (a mention of CONVENTIONS.md is a no-op) and
 * conservative: handles the common scalar (`read: X`) and block-list forms, but
 * refuses to text-edit a flow list (`read: [a, b]`) — it returns `manual:true`
 * so the caller can tell the user to add the entry by hand rather than risk
 * corrupting their YAML.
 */
export function mergeAiderRead(existing: string): {
  next: string;
  changed: boolean;
  manual?: boolean;
} {
  if (/CONVENTIONS\.md/.test(existing)) return { next: existing, changed: false };
  const lines = existing.split("\n");
  const readIdx = lines.findIndex((l) => /^read\s*:/.test(l));
  if (readIdx === -1) {
    const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
    return { next: existing + sep + "read:\n  - CONVENTIONS.md\n", changed: true };
  }
  const rhs = (lines[readIdx].match(/^read\s*:\s*(.*)$/)?.[1] ?? "").trim();
  if (rhs === "") {
    // Block list (or empty) follows — match the existing item indent if any.
    let indent = "  ";
    for (let i = readIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)-\s+/);
      if (m) {
        indent = m[1];
        break;
      }
      if (lines[i].trim() !== "" && !/^\s/.test(lines[i])) break; // next top-level key
    }
    lines.splice(readIdx + 1, 0, `${indent}- CONVENTIONS.md`);
    return { next: lines.join("\n"), changed: true };
  }
  if (rhs.startsWith("[")) return { next: existing, changed: false, manual: true };
  // Scalar value → promote to a two-item block list.
  const val = rhs.replace(/^["']|["']$/g, "");
  lines[readIdx] = `read:\n  - ${val}\n  - CONVENTIONS.md`;
  return { next: lines.join("\n"), changed: true };
}

/**
 * Aider rules — a BESPOKE installer (not an `AGENT_TARGETS` row). Aider does NOT
 * auto-read any rules file, so dropping `CONVENTIONS.md` alone is a no-op. This
 * does TWO things idempotently: (1) writes the managed kit block into
 * `CONVENTIONS.md`, and (2) ensures `.aider.conf.yml` carries `read: CONVENTIONS.md`
 * so aider actually loads it. Detected via `.aider.conf.yml` /
 * `.aider.chat.history.md` / `.aider.input.history`.
 */
export async function installAiderRules(
  cwd: string = process.cwd(),
  userRules?: UserRulesProfile | null,
): Promise<AgentConfigResult> {
  const file = "CONVENTIONS.md";
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("install-aider-rules", {});
    return { agent: "Aider", file, action: "failed", detail: refusal.reason };
  }
  const detected =
    existsSync(resolve(cwd, ".aider.conf.yml")) ||
    existsSync(resolve(cwd, ".aider.chat.history.md")) ||
    existsSync(resolve(cwd, ".aider.input.history"));
  if (!detected) {
    return { agent: "Aider", file, action: "unchanged", detail: "no Aider project detected" };
  }

  // (1) CONVENTIONS.md kit block.
  const convPath = resolve(cwd, file);
  let existing: string;
  try {
    existing = await readFile(convPath, "utf-8");
  } catch {
    existing = "";
  }
  const { next, action } = upsertKitBlock(existing, userRules);
  try {
    if (action !== "unchanged") await writeFile(convPath, next, "utf-8");
  } catch (err) {
    return {
      agent: "Aider",
      file,
      action: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // (2) .aider.conf.yml `read: CONVENTIONS.md` — the step that makes it non-no-op.
  const confPath = resolve(cwd, ".aider.conf.yml");
  let conf: string;
  try {
    conf = await readFile(confPath, "utf-8");
  } catch {
    conf = "";
  }
  const merged = mergeAiderRead(conf);
  let confNote = "read: CONVENTIONS.md already set";
  if (merged.manual) {
    confNote = "add `- CONVENTIONS.md` under read: in .aider.conf.yml (flow list not auto-merged)";
  } else if (merged.changed) {
    try {
      await writeFile(confPath, merged.next, "utf-8");
      confNote = "wired read: CONVENTIONS.md in .aider.conf.yml";
    } catch (err) {
      return {
        agent: "Aider",
        file: ".aider.conf.yml",
        action: "failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const blockNote =
    action === "created"
      ? "wrote kit block to CONVENTIONS.md"
      : action === "updated"
        ? "updated kit block in CONVENTIONS.md"
        : "kit block already current";
  return {
    agent: "Aider",
    file,
    action: action === "unchanged" && !merged.changed ? "unchanged" : "updated",
    detail: `${blockNote}; ${confNote}`,
  };
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

export const CODEX_KIT_PROFILE_NAME = "kit";
export const CODEX_PROFILE_BLOCK_BEGIN = "# BEGIN kit (managed Codex profile)";
export const CODEX_PROFILE_BLOCK_END = "# END kit";
export const CODEX_KIT_PROFILE_BLOCK = `${CODEX_PROFILE_BLOCK_BEGIN}
# Personal Codex profile generated by kit. Use: codex --profile ${CODEX_KIT_PROFILE_NAME}
approval_policy = "on-request"
sandbox_mode = "workspace-write"
${CODEX_PROFILE_BLOCK_END}`;

export interface CodexProfileResult {
  file: string;
  profile: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  detail?: string;
}

export function codexHomeDir(): string {
  return process.env.KIT_CODEX_DIR ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexKitProfilePath(): string {
  return join(codexHomeDir(), `${CODEX_KIT_PROFILE_NAME}.config.toml`);
}

function upsertCodexKitProfileBlock(existing: string): {
  next: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  detail?: string;
} {
  const begin = existing.indexOf(CODEX_PROFILE_BLOCK_BEGIN);
  const end = existing.indexOf(CODEX_PROFILE_BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + CODEX_PROFILE_BLOCK_END.length);
    const next = before + CODEX_KIT_PROFILE_BLOCK + after;
    return { next, action: next === existing ? "unchanged" : "updated" };
  }

  // This is a personal profile file. If the operator already declared either
  // setting outside kit's managed block, do not silently change their risk mode.
  if (/^\s*(approval_policy|sandbox_mode)\s*=/m.test(existing)) {
    return {
      next: existing,
      action: "skipped",
      detail: "existing profile owns approval_policy/sandbox_mode; not overwriting",
    };
  }

  const sep =
    existing.length === 0
      ? ""
      : existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
  return {
    next: `${existing}${sep}${CODEX_KIT_PROFILE_BLOCK}\n`,
    action: existing.length === 0 ? "created" : "updated",
  };
}

/**
 * Codex has no Claude-style command allowlist surface. The low-friction,
 * current Codex-native equivalent is a personal profile selected explicitly by
 * `codex --profile kit`: workspace-write sandbox, on-request approvals.
 *
 * This writes under CODEX_HOME / ~/.codex, never into repo config, because
 * approval risk tolerance is a personal machine setting.
 */
export async function installCodexKitProfile(
  path: string = codexKitProfilePath(),
): Promise<CodexProfileResult> {
  const file = path;
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    return {
      file,
      profile: CODEX_KIT_PROFILE_NAME,
      action: "skipped",
      detail: "read-only mode",
    };
  }

  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    // Missing profile is the normal first-run path.
  }

  const { next, action, detail } = upsertCodexKitProfileBlock(existing);
  if (action === "unchanged" || action === "skipped") {
    return { file, profile: CODEX_KIT_PROFILE_NAME, action, detail };
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next, "utf-8");
    return { file, profile: CODEX_KIT_PROFILE_NAME, action };
  } catch (err) {
    return {
      file,
      profile: CODEX_KIT_PROFILE_NAME,
      action: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
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

/**
 * The gate command for a non-login hook shell. Mirrors the memory-hook invocation
 * (`kitHookInvocation`): prefer the self-healing wrapper at the STABLE path
 * `~/.kit/bin/kit`. Two concrete wins over baking `<node> <cli.js>` straight into
 * every agent's config:
 *   1. It restores the tool PATH a non-login hook shell drops (npm-global bin, mise
 *      shims). The gate shells out to `python3` (triage) and `git`; without that
 *      PATH those fail — triage then fail-closes and BLOCKS legitimate installs
 *      (false-block spam), the opposite of what we want operators to live with.
 *   2. There is ONE stable path to refresh. If node moves (nvm/volta/fnm) or kit
 *      relocates, `ensureKitWrapper` rewrites the single wrapper in place and every
 *      agent's hook — which all point at `~/.kit/bin/kit` — is fixed at once; no
 *      per-agent re-wiring, and no stale absolute node path frozen into a config
 *      file that would make the PreToolUse hook fail to spawn (a silent false green).
 * Fall back to an absolute `<node> <cli.js>`, then a bare `kit` (relies on PATH —
 * the last resort, kept only so the string is never empty).
 */
export function kitGateInvocation(): string {
  return kitSubcommandInvocation("gate-bash");
}

/** Same stable-wrapper resolution for any kit subcommand baked into a hook. */
function kitSubcommandInvocation(sub: string): string {
  const wrapper = kitWrapperPath();
  if (existsSync(wrapper)) return `${wrapper} ${sub}`;
  const entry = process.argv[1];
  if (entry) return `${process.execPath} ${resolve(entry)} ${sub}`;
  return `kit ${sub}`; // last resort — relies on PATH
}

const GATE_SUBCOMMANDS = ["gate-bash", "gate-env", "gate-egress", "gate-fs"];

function commandIncludesSubcommand(command: string, sub: string): boolean {
  try {
    return shellSplit(command).includes(sub);
  } catch {
    return command.endsWith(sub) || command.includes(` ${sub}`);
  }
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o111) !== 0;
}

function managedWrapperProblems(path: string): string[] {
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  if (!body.includes(WRAPPER_MARKER)) return [];
  const match = body.match(/exec "([^"]+)" "([^"]+)" "\$@"/);
  if (!match) {
    return [`managed kit wrapper is malformed: ${path}. Run: kit agent-config`];
  }
  const [, nodePath, cliPath] = match;
  const problems: string[] = [];
  if (!isExecutable(nodePath)) {
    problems.push(`managed kit wrapper points at missing/non-executable node: ${nodePath}`);
  }
  if (!existsSync(cliPath)) {
    problems.push(`managed kit wrapper points at missing kit CLI: ${cliPath}`);
  }
  return problems.map((p) => `${p}. Run: kit agent-config`);
}

function hookCommandProblems(command: string): string[] {
  let argv: string[];
  try {
    argv = shellSplit(command);
  } catch (err) {
    return [
      `cannot parse hook command ${JSON.stringify(command)}: ${err instanceof Error ? err.message : String(err)}. Run: kit agent-config`,
    ];
  }
  if (argv.length === 0) return ["empty hook command. Run: kit agent-config"];
  let exe = argv[0];
  if (exe === "exec" && argv[1]) exe = argv[1];
  if (exe === "kit") {
    return [
      "hook command uses bare `kit`; non-login hook shells often lack PATH setup, causing exit 127. Run: kit agent-config",
    ];
  }
  const expanded = expandHomePath(exe);
  if (!isAbsolute(expanded)) {
    return [
      `hook command uses non-absolute executable \`${exe}\`; non-login hook shells may not resolve it. Run: kit agent-config`,
    ];
  }
  if (expanded.startsWith("/root/")) {
    return [
      `hook command points at ${expanded}, which looks like a root/container path on this machine. Run: kit agent-config in this repo to rewrite hooks for ${homedir()}`,
    ];
  }
  if (!isExecutable(expanded)) {
    return [`hook command target missing or not executable: ${expanded}. Run: kit agent-config`];
  }
  return managedWrapperProblems(expanded);
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
 * Gate liveness — is the deterministic ENFORCEMENT floor actually wired, or has it
 * silently vanished? A gate is only real if it's on the agent's action path; a
 * machine where kit installed the PreToolUse gates but they were later removed looks
 * green while the agent runs un-gated — the worst false green (the "floor that isn't
 * there"). This makes the floor prove it exists. Deterministic, read-only.
 *
 * The "expected" signal is a MACHINE-LOCAL marker written when a gate is installed —
 * NOT the committed CLAUDE.md block. The block travels with the repo (present in any
 * fresh checkout / CI), but the gates live in the gitignored, machine-local
 * `.claude/settings.json`; keying off the block would false-fail every clone that
 * commits its block and gitignores `.claude/` (the normal setup). The marker lives
 * beside the gates (also gitignored), so a fresh checkout has neither → correctly
 * "not installed here", while a set-up machine that lost a gate → degradation.
 */
export interface GateLiveness {
  /** Gates were installed on THIS machine for this project (marker present). */
  everInstalled: boolean;
  /** PreToolUse install-gate (`gate-bash`) present in .claude/settings.json. */
  installGate: boolean;
  /** PreToolUse env-write-gate (`gate-env`) present. */
  envGate: boolean;
  /** PreToolUse exec-broker egress gate (`gate-egress`) present. */
  egressGate: boolean;
  /** Hook rows exist but cannot reliably spawn; these produce harness-level code 127 noise. */
  problems: string[];
}

/** Machine-local marker recording that kit installed the gates here (gitignored, beside them). */
export function gateMarkerPath(cwd: string = process.cwd()): string {
  return resolve(cwd, ".claude/.kit-gates-installed");
}

/** Record that the enforcement gates were installed here (best-effort; never throws). */
export function markGatesInstalled(cwd: string = process.cwd()): void {
  try {
    const dir = resolve(cwd, ".claude");
    if (!existsSync(dir)) return; // no .claude/ → not a Claude Code project; nothing to mark
    writeFileSync(gateMarkerPath(cwd), new Date().toISOString() + "\n");
  } catch {
    /* marking is advisory — a failed touch must never break gate installation */
  }
}

export function gateLiveness(
  cwd: string = process.cwd(),
  settingsPath: string = resolve(cwd, ".claude/settings.json"),
): GateLiveness {
  const everInstalled = existsSync(gateMarkerPath(cwd));
  let pre: SettingsHookGroup[];
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks?: Record<string, SettingsHookGroup[]>;
    };
    pre = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  } catch {
    pre = []; // missing/unparseable settings → no gates present (surfaced as a problem)
  }
  const gateCommands = pre
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command)
    .filter((cmd): cmd is string => typeof cmd === "string")
    .filter((cmd) => GATE_SUBCOMMANDS.some((sub) => commandIncludesSubcommand(cmd, sub)));
  const has = (sub: string) => gateCommands.some((cmd) => commandIncludesSubcommand(cmd, sub));
  return {
    everInstalled,
    installGate: has("gate-bash"),
    envGate: has("gate-env"),
    egressGate: has("gate-egress"),
    problems: gateCommands.flatMap((cmd) => hookCommandProblems(cmd)),
  };
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
  if (already) {
    markGatesInstalled(cwd); // gate present → record it for liveness (idempotent)
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }

  pre.push({ matcher: "Bash", hooks: [{ type: "command", command: kitGateInvocation() }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    markGatesInstalled(cwd);
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Install the PreToolUse env-write-gate into `.claude/settings.json`: block a
 * Write/Edit that puts a plaintext secret into a real `.env*` file BEFORE it lands
 * (`kit gate-env`) — the *enforce* layer for the "never write secrets to .env*"
 * rule, which as prose only advises. Idempotent (keyed on a command ending in
 * `gate-env`); preserves other hooks. Claude Code only (the Write/Edit tool shapes
 * we know); other agents keep the after-the-fact plaintext scan in `kit check`.
 */
export async function installEnvWriteGate(cwd: string = process.cwd()): Promise<HookInstallResult> {
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
  const already = pre.some((g) => g.hooks?.some((h) => h.command?.endsWith("gate-env")));
  if (already) {
    markGatesInstalled(cwd);
    return { file, action: "unchanged", detail: "env-write-gate already wired" };
  }

  pre.push({
    matcher: "Write|Edit|NotebookEdit",
    hooks: [{ type: "command", command: kitSubcommandInvocation("gate-env") }],
  });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    markGatesInstalled(cwd);
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Install the exec-broker PreToolUse gates (Pillar 3) into `.claude/settings.json`:
 * `kit gate-egress` (matcher `Bash`) blocks network targets outside the signed [scope].egress,
 * and `kit gate-fs` (matcher `Write|Edit|NotebookEdit`) blocks writes outside [scope].fs.
 *
 * Unlike the install/env gates this is OPT-IN (`kit agent-config --broker-gate`), NOT default:
 * the broker is fail-closed, so a wired egress-gate with no verified scope denies ALL network
 * — desirable only once the operator has declared + signed a `[scope]`/RoE. Wiring it is that
 * deliberate opt-in. Claude Code only today (the settings schema we know); idempotent (keyed on
 * each gate command); preserves other hooks.
 */
export async function installBrokerGates(cwd: string = process.cwd()): Promise<HookInstallResult> {
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
  const wired = (sub: string) => pre.some((g) => g.hooks?.some((h) => h.command?.endsWith(sub)));
  const hasEgress = wired("gate-egress");
  const hasFs = wired("gate-fs");
  if (hasEgress && hasFs) {
    return { file, action: "unchanged", detail: "broker gates already wired" };
  }
  if (!hasEgress) {
    pre.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: kitSubcommandInvocation("gate-egress") }],
    });
  }
  if (!hasFs) {
    pre.push({
      matcher: "Write|Edit|NotebookEdit",
      hooks: [{ type: "command", command: kitSubcommandInvocation("gate-fs") }],
    });
  }
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

  let existing: string;
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
  let agentFiles: string[];
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
 * AWS Kiro (CLI) install-gate: add a `hooks.preToolUse` entry (matcher
 * `execute_bash`) to each Kiro agent config under `.kiro/agents/*.json`. Kiro CLI
 * is Amazon-Q-lineage — same agent-config hook schema (`hooks.preToolUse` array of
 * `{matcher, command}`), same `tool_input.command` STDIN, same exit-2-blocks — so
 * `kit gate-bash` works unchanged. Like Amazon Q, hooks are per-agent, so we wire
 * every existing agent file and SKIP (honestly, no false-green) when none exist
 * rather than write a partial/invalid agent config. Idempotent.
 */
export async function installInstallGateKiro(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const dir = ".kiro/agents";
  const dirPath = resolve(cwd, dir);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file: dir, action: "skipped", detail: "read-only mode" };
  let agentFiles: string[];
  try {
    agentFiles = readdirSync(dirPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dirPath, f));
  } catch {
    agentFiles = [];
  }
  if (agentFiles.length === 0) {
    return {
      file: dir,
      action: "skipped",
      detail: "no Kiro agent config found (create .kiro/agents/*.json first)",
    };
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
  return { file: dir, action: "updated", detail: `wired ${wired} Kiro agent config(s)` };
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

/** The gate command as an argv array (`[node, cli.js, "gate-bash"]`) for execFileSync.
 *  On POSIX the self-healing wrapper is a shebanged, executable sh script that
 *  execFileSync can spawn directly, so prefer it for the same node-version-switch
 *  resilience as `kitGateInvocation`. On win32 the POSIX wrapper is not runnable via
 *  execFileSync (no shebang honoring), so keep the absolute node+cli form there. */
export function kitGateArgv(): string[] {
  if (process.platform !== "win32") {
    const wrapper = kitWrapperPath();
    if (existsSync(wrapper)) return [wrapper, "gate-bash"];
  }
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

/**
 * Factory Droid install-gate: a `PreToolUse` hook in `.factory/hooks.json`. Droid
 * is Claude-Code-compatible and uses the same nested `{hooks:{PreToolUse:[{matcher,
 * hooks:[{type:"command",command}]}]}}` shape — the ONE adaptation is the shell
 * matcher is `"Execute"` (not `"Bash"`). Droid passes the command at
 * `tool_input.command` and blocks on exit 2, so `kit gate-bash` works unchanged.
 * Idempotent (keyed on a `gate-bash` command); also treats the legacy
 * `.factory/hooks/hooks.json` as already-wired so we don't double-install.
 * Preserves any other hooks/settings.
 */
export async function installInstallGateDroid(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".factory/hooks.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".factory"))) {
    return { file, action: "skipped", detail: "no Factory Droid project detected" };
  }

  // Legacy location: if a prior hooks file already carries the gate, do nothing.
  const legacy = resolve(cwd, ".factory/hooks/hooks.json");
  if (existsSync(legacy)) {
    try {
      if ((await readFile(legacy, "utf-8")).includes("gate-bash")) {
        return {
          file: ".factory/hooks/hooks.json",
          action: "unchanged",
          detail: "install-gate already wired",
        };
      }
    } catch {
      // unreadable legacy file → fall through and write the scope-root file
    }
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
  if (pre.some((g) => g.hooks?.some((h) => h.command?.endsWith("gate-bash")))) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  pre.push({ matcher: "Execute", hooks: [{ type: "command", command: kitGateInvocation() }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Augment (Auggie) install-gate: a `PreToolUse` hook in `.augment/settings.json`
 * (same nested hooks > Event > matcher > hooks[] shape as Claude Code). The one
 * adaptation is the shell-tool matcher is `"launch-process"` (Augment's process
 * tool). Augment passes the command at `tool_input.command` and blocks on exit 2,
 * so `kit gate-bash` works unchanged. We write the committable project file
 * (config precedence: system > project `.augment/settings.json` > `.local` > user).
 * Idempotent; preserves other settings/hooks.
 */
export async function installInstallGateAugment(
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const file = ".augment/settings.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".augment")) && !existsSync(resolve(cwd, ".augment-guidelines"))) {
    return { file, action: "skipped", detail: "no Augment project detected" };
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
  if (pre.some((g) => g.hooks?.some((h) => h.command?.endsWith("gate-bash")))) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  pre.push({
    matcher: "launch-process",
    hooks: [{ type: "command", command: kitGateInvocation() }],
  });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Google Antigravity install-gate: a `PreToolUse` hook in the workspace-scoped
 * `.agents/hooks.json` (preferred over the global ~/.gemini/config/hooks.json to
 * keep kit's per-project pattern). Distinct from the Gemini CLI gate: event key
 * `"PreToolUse"` (not `BeforeTool`), matcher `"run_command"`. Antigravity carries
 * the command at `toolCall.args.CommandLine` — handled by the extended
 * `extractCommandFromHookPayload` — and blocks on exit 2, so `kit gate-bash`
 * works unchanged. Idempotent; preserves other hooks. Detected via a repo
 * `.agents/` dir.
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
  if (pre.some((g) => g.hooks?.some((h) => h.command?.endsWith("gate-bash")))) {
    return { file, action: "unchanged", detail: "install-gate already wired" };
  }
  pre.push({ matcher: "run_command", hooks: [{ type: "command", command: kitGateInvocation() }] });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { file, action: existed ? "updated" : "created" };
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Per-agent install-gate result. */
export interface GateInstallEntry {
  agent:
    | "Claude Code"
    | "Claude Code (env-write)"
    | "Codex"
    | "Amazon Q"
    | "Kiro"
    | "Factory Droid"
    | "Augment"
    | "Antigravity"
    | "Gemini CLI"
    | "Cursor"
    | "OpenCode"
    | "Cline";
  result: HookInstallResult;
}

/** Wire the PreToolUse install-gate for every supported agent present in the project. */
export async function installAllInstallGates(
  cwd: string = process.cwd(),
): Promise<GateInstallEntry[]> {
  // Write/refresh the self-healing wrapper FIRST so every gate hook below embeds a
  // wrapper invocation (which survives a node-version switch) instead of a baked
  // node path. Best-effort and skipped in read-only mode; if the wrapper can't be
  // written, kitGateInvocation()/kitGateArgv() transparently fall back to the
  // absolute node+cli form.
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (!isReadOnlyMode()) ensureKitWrapper();
  return [
    { agent: "Claude Code", result: await installInstallGate(cwd) },
    { agent: "Codex", result: await installInstallGateCodex(cwd) },
    { agent: "Amazon Q", result: await installInstallGateAmazonQ(cwd) },
    { agent: "Kiro", result: await installInstallGateKiro(cwd) },
    { agent: "Factory Droid", result: await installInstallGateDroid(cwd) },
    { agent: "Augment", result: await installInstallGateAugment(cwd) },
    { agent: "Antigravity", result: await installInstallGateAntigravity(cwd) },
    { agent: "Gemini CLI", result: await installInstallGateGemini(cwd) },
    { agent: "Cursor", result: await installInstallGateCursor(cwd) },
    { agent: "OpenCode", result: await installInstallGateOpenCode(cwd) },
    { agent: "Cline", result: await installInstallGateCline(cwd) },
    // Env-write-gate (block plaintext secrets aimed at .env* BEFORE they land) —
    // Claude Code only today; other agents keep the after-the-fact plaintext scan.
    { agent: "Claude Code (env-write)", result: await installEnvWriteGate(cwd) },
  ];
}
