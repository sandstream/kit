import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

import { ensureKitWrapper, kitWrapperPath } from "./kit-wrapper.js";

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
 *  every turn, so it states the rules, not the rationale. Rules that have gained a
 *  DETERMINISTIC enforcement layer (hooks/gates) are stated as facts, not asks —
 *  prose only advises, so each rule migrates out of this block as its gate ships
 *  (statusline → session-start injection; triage → gate-bash; .env secrets →
 *  gate-env; elevation → enforced in the CLI itself). */
export const KIT_INSTRUCTION = `## kit

This project uses [kit](https://github.com/sandstream/kit) to manage tools, secrets, and environment setup. The hard rules are ENFORCED by hooks, not this text: the session-start hook injects the kit statusline (setup score · update mark · open-PAL count) as context, and PreToolUse gates block un-triaged package installs and plaintext secrets aimed at \`.env*\` before they happen. As the agent working here:

- Run \`kit check\` before starting; if it reports \`fail\`, run \`kit fix\` then re-check.
- Recall prior decisions with \`kit memory search "<query>"\` (cross-session, cross-agent).
- Resolve secrets with \`kit secrets\` (vault-backed); put placeholders in \`.env.example\` — the env-gate blocks plaintext \`.env*\` writes.
- For dependencies outside the install-gate's reach (git repos, URLs, vendored code), run \`kit triage repo <target>\` first.
- After a batch of edits, run \`kit check --category security\`; halt and surface findings on \`fail\`.
- Destructive secret ops require \`kit auth elevate\` first (the CLI enforces this).`;

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
export async function installAiderRules(cwd: string = process.cwd()): Promise<AgentConfigResult> {
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
  let existing = "";
  try {
    existing = await readFile(convPath, "utf-8");
  } catch {
    existing = "";
  }
  const { next, action } = upsertKitBlock(existing);
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
  let conf = "";
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
 * silently vanished? A gate is only real if it's on the agent's action path; a repo
 * that was taught kit (managed block present) but whose PreToolUse gates were removed
 * looks green while the agent runs un-gated — the worst false green (the "floor that
 * isn't there"). This makes the floor prove it exists. Deterministic, read-only.
 *
 * `taught` = a managed "use kit" block exists in an agent rules file here (i.e.
 * `kit agent teach` ran, which installs the gates by default). Only then are the
 * gates EXPECTED — a never-taught repo isn't a degradation, just un-adopted.
 */
export interface GateLiveness {
  /** kit agent-config ran here (managed block present in a rules file). */
  taught: boolean;
  /** PreToolUse install-gate (`gate-bash`) present in .claude/settings.json. */
  installGate: boolean;
  /** PreToolUse env-write-gate (`gate-env`) present. */
  envGate: boolean;
}

export function gateLiveness(
  cwd: string = process.cwd(),
  settingsPath: string = resolve(cwd, ".claude/settings.json"),
): GateLiveness {
  const taught = AGENT_TARGETS.some((t) => {
    try {
      return readFileSync(resolve(cwd, t.file), "utf-8").includes(KIT_BLOCK_BEGIN);
    } catch {
      return false;
    }
  });
  let pre: SettingsHookGroup[] = [];
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks?: Record<string, SettingsHookGroup[]>;
    };
    pre = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  } catch {
    pre = []; // missing/unparseable settings → no gates present (surfaced as a problem)
  }
  const has = (suffix: string) =>
    pre.some((g) => g.hooks?.some((h) => h.command?.endsWith(suffix)));
  return { taught, installGate: has("gate-bash"), envGate: has("gate-env") };
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
  if (already) return { file, action: "unchanged", detail: "env-write-gate already wired" };

  pre.push({
    matcher: "Write|Edit|NotebookEdit",
    hooks: [{ type: "command", command: kitSubcommandInvocation("gate-env") }],
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
  let agentFiles: string[] = [];
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
