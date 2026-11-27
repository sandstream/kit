/**
 * Where each coding agent keeps its saved allow, ask and deny rules, read per harness and scope.
 * Each store is the one its vendor documents (checked 2026-11-27):
 *
 *   - Claude Code (code.claude.com/docs/en/settings, managed-settings): `permissions.allow`,
 *     `ask` and `deny` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), `.claude/settings.json`,
 *     `.claude/settings.local.json`, and the managed `managed-settings.json` plus
 *     `managed-settings.d/*.json` in `/etc/claude-code` (Linux, WSL),
 *     `/Library/Application Support/ClaudeCode` (macOS) or `C:\Program Files\ClaudeCode` (Windows).
 *   - Codex (learn.chatgpt.com/docs/agent-configuration/rules): `prefix_rule(...)` in
 *     `$CODEX_HOME/rules/*.rules` and `<repo>/.codex/rules/*.rules`, parsed as text
 *     (`codex-rules.ts`). `allow` runs outside the sandbox without a prompt.
 *   - Cursor CLI (cursor.com/docs/cli/reference/permissions): `permissions.allow` and `deny` in
 *     `~/.cursor/cli-config.json` and `<repo>/.cursor/cli.json`.
 *   - Gemini CLI (geminicli.com/docs/reference/configuration): `tools.allowed` (no confirmation),
 *     `tools.exclude`, `general.defaultApprovalMode: "auto_edit"`, and the older `autoAccept`, in
 *     `~/.gemini/settings.json`, `.gemini/settings.json` and the system files.
 *
 * Not read, and named as such in the output: see `NOT_COVERED`. A file that exists but cannot be
 * read as its format gives an unparsed row; a rule entry that is not a string does too.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix, relative, sep, win32 } from "node:path";

import { codexHome } from "./agent-audit-user.js";
import { parseCodexRules, showPattern, type CodexRule } from "./codex-rules.js";

export type Harness = "Claude Code" | "Codex" | "Cursor CLI" | "Gemini CLI";
export type Scope = "user" | "project" | "local" | "managed";
export type Kind = "allow" | "ask" | "deny" | "unparsed";

export interface RawRule {
  harness: Harness;
  scope: Scope;
  /** How the file is shown: `~/…`, a project-relative path, or a system path. */
  file: string;
  rule: string;
  kind: Kind;
  /** The rule in Claude Code's grant shape, for the trifecta tables. Empty when unparsed. */
  grants: string[];
  /** Codex `allow`: runs outside the sandbox. */
  unsandboxed?: boolean;
}

/** Harnesses kit wires or names whose rule stores this ledger does not read yet. */
export const NOT_COVERED = [
  "Antigravity (store not verified against its docs)",
  "Copilot CLI (docs not read)",
  "Amazon Q",
  "AWS Kiro",
  "Factory Droid",
  "Augment",
  "OpenCode",
  "Cline",
  "Continue",
  "Codex team and system config layers",
  "Gemini CLI policy files",
  "Claude Code MDM, registry and server-managed policy",
];

interface Ctx {
  root: string;
  home: string;
  env: Record<string, unknown>;
  platform: NodeJS.Platform;
  /** Override for the managed settings directories (tests). */
  managedDirs?: string[];
}

type Source = { harness: Harness; scope: Scope; abs: string; file: string };

/** Claude Code's managed settings directory for an OS. Pure. */
export function claudeManagedDir(platform: NodeJS.Platform, env: Record<string, unknown>): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") {
    const pf = typeof env.ProgramFiles === "string" && env.ProgramFiles ? env.ProgramFiles : null;
    return win32.join(pf ?? "C:\\Program Files", "ClaudeCode");
  }
  return "/etc/claude-code";
}

/** Gemini CLI's system settings files for an OS. Pure. */
export function geminiSystemFiles(platform: NodeJS.Platform): string[] {
  const dir =
    platform === "darwin"
      ? "/Library/Application Support/GeminiCli"
      : platform === "win32"
        ? "C:\\ProgramData\\gemini-cli"
        : "/etc/gemini-cli";
  const p = platform === "win32" ? win32 : posix;
  return [p.join(dir, "system-defaults.json"), p.join(dir, "settings.json")];
}

function projectFile(ctx: Ctx, ...parts: string[]): { abs: string; file: string } {
  const abs = join(ctx.root, ...parts);
  return { abs, file: relative(ctx.root, abs).split(sep).join("/") };
}

function claudeSources(ctx: Ctx): Source[] {
  const custom = typeof ctx.env.CLAUDE_CONFIG_DIR === "string" && ctx.env.CLAUDE_CONFIG_DIR;
  const userDir = custom ? String(ctx.env.CLAUDE_CONFIG_DIR) : join(ctx.home, ".claude");
  const out: Source[] = [
    {
      harness: "Claude Code",
      scope: "user",
      abs: join(userDir, "settings.json"),
      file: custom ? "$CLAUDE_CONFIG_DIR/settings.json" : "~/.claude/settings.json",
    },
    { harness: "Claude Code", scope: "project", ...projectFile(ctx, ".claude", "settings.json") },
    {
      harness: "Claude Code",
      scope: "local",
      ...projectFile(ctx, ".claude", "settings.local.json"),
    },
  ];
  for (const dir of ctx.managedDirs ?? [claudeManagedDir(ctx.platform, ctx.env)]) {
    const main = join(dir, "managed-settings.json");
    out.push({ harness: "Claude Code", scope: "managed", abs: main, file: main });
    for (const f of listDir(join(dir, "managed-settings.d"), ".json")) {
      out.push({ harness: "Claude Code", scope: "managed", abs: f, file: f });
    }
  }
  return out;
}

/** Files in a directory with an extension, sorted, hidden files left out. */
function listDir(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(ext) && !n.startsWith("."))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false };

function readJsonFile(abs: string): Parsed | null {
  if (!existsSync(abs)) return null;
  try {
    const v = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return { ok: true, value: v as Record<string, unknown> };
    }
  } catch {
    // fall through: unreadable or not JSON
  }
  return { ok: false };
}

function unparsed(src: Source, text: string): RawRule {
  return { ...pick(src), rule: text, kind: "unparsed", grants: [] };
}

function pick(src: Source): Pick<RawRule, "harness" | "scope" | "file"> {
  return { harness: src.harness, scope: src.scope, file: src.file };
}

/** String entries of a rule list; anything else becomes an unparsed row. */
function listRules(src: Source, v: unknown, kind: Kind, grant: (r: string) => string[]) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return [unparsed(src, `${kind}: not a list`)];
  return v.map((r): RawRule =>
    typeof r === "string"
      ? { ...pick(src), rule: r, kind, grants: grant(r) }
      : unparsed(src, `${kind}: ${JSON.stringify(r) ?? String(r)}`),
  );
}

function readClaude(src: Source): RawRule[] {
  const parsed = readJsonFile(src.abs);
  if (parsed === null) return [];
  if (!parsed.ok) return [unparsed(src, "file is not a JSON object")];
  const perms = parsed.value.permissions;
  if (perms === undefined) return [];
  if (typeof perms !== "object" || perms === null) return [unparsed(src, "permissions")];
  const p = perms as Record<string, unknown>;
  const same = (r: string) => [r];
  return [
    ...listRules(src, p.allow, "allow", same),
    ...listRules(src, p.ask, "ask", same),
    ...listRules(src, p.deny, "deny", same),
  ];
}

/** A Codex prefix as Claude Code grants, one per first-word alternative. */
function codexGrants(rule: CodexRule): string[] {
  const rest = rule.pattern.slice(1).map((alts) => alts[0]);
  return rule.pattern[0].map((first) => `Bash(${[first, ...rest].join(" ")}:*)`);
}

const CODEX_KIND: Record<string, Kind> = { allow: "allow", prompt: "ask", forbidden: "deny" };

function readCodex(src: Source): RawRule[] {
  let text: string;
  try {
    text = readFileSync(src.abs, "utf8");
  } catch {
    return [unparsed(src, "file could not be read")];
  }
  return parseCodexRules(text).map((s): RawRule => {
    if (!s.ok) return unparsed(src, s.text);
    return {
      ...pick(src),
      rule: `prefix_rule: ${showPattern(s.rule.pattern)}`,
      kind: CODEX_KIND[s.rule.decision],
      grants: codexGrants(s.rule),
      unsandboxed: s.rule.decision === "allow",
    };
  });
}

function codexSources(ctx: Ctx): Source[] {
  const codex = codexHome(ctx.home, ctx.env);
  const user = listDir(join(codex.dir, "rules"), ".rules").map((abs) => ({
    harness: "Codex" as const,
    scope: "user" as const,
    abs,
    file: `${codex.shown}/rules/${basename(abs)}`,
  }));
  const project = listDir(join(ctx.root, ".codex", "rules"), ".rules").map((abs) => ({
    harness: "Codex" as const,
    scope: "project" as const,
    abs,
    file: `.codex/rules/${basename(abs)}`,
  }));
  return [...user, ...project];
}

/** A Cursor CLI permission token as a Claude Code grant. `Shell(x)` matches the first word. */
function cursorGrant(token: string): string {
  const m = /^(Shell|Read|Write|WebFetch|Mcp)\((.*)\)$/.exec(token);
  if (!m) return token;
  const [, kind, arg] = m;
  if (kind === "Shell") return arg.includes(":") || arg === "*" ? `Bash(${arg})` : `Bash(${arg}:*)`;
  if (kind === "Mcp") return `mcp__${arg.replace(":", "__")}`;
  return `${kind}(${arg})`;
}

function readCursor(src: Source): RawRule[] {
  const parsed = readJsonFile(src.abs);
  if (parsed === null) return [];
  if (!parsed.ok) return [unparsed(src, "file is not a JSON object")];
  const perms = parsed.value.permissions;
  if (perms === undefined) return [];
  if (typeof perms !== "object" || perms === null) return [unparsed(src, "permissions")];
  const p = perms as Record<string, unknown>;
  const g = (r: string) => [cursorGrant(r)];
  return [...listRules(src, p.allow, "allow", g), ...listRules(src, p.deny, "deny", g)];
}

const GEMINI_TOOLS: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  glob: "Glob",
  search_file_content: "Grep",
  list_directory: "Glob",
  write_file: "Write",
  replace: "Edit",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
};

/** A Gemini CLI tool name as a Claude Code grant. Shell arguments match as a prefix. */
function geminiGrant(tool: string): string {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(tool);
  const name = m ? GEMINI_TOOLS[m[1]] : undefined;
  if (!m || !name) return tool;
  if (m[2] === undefined) return name;
  return name === "Bash" ? `Bash(${m[2]}:*)` : `${name}(${m[2]})`;
}

function geminiFlags(src: Source, v: Record<string, unknown>): RawRule[] {
  const tools = (v.tools ?? {}) as Record<string, unknown>;
  const general = (v.general ?? {}) as Record<string, unknown>;
  const out: RawRule[] = [];
  for (const [key, on] of [
    ["tools.autoAccept", tools.autoAccept],
    ["autoAccept", v.autoAccept],
  ] as const) {
    if (on === true)
      out.push({
        ...pick(src),
        rule: `${key}: true`,
        kind: "allow",
        grants: ["Read", "Glob", "Grep"],
      });
  }
  if (general.defaultApprovalMode === "auto_edit") {
    out.push({
      ...pick(src),
      rule: "general.defaultApprovalMode: auto_edit",
      kind: "allow",
      grants: ["Edit"],
    });
  }
  return out;
}

function readGemini(src: Source): RawRule[] {
  const parsed = readJsonFile(src.abs);
  if (parsed === null) return [];
  if (!parsed.ok) return [unparsed(src, "file is not a JSON object")];
  const v = parsed.value;
  const tools = v.tools;
  if (tools !== undefined && (typeof tools !== "object" || tools === null)) {
    return [unparsed(src, "tools")];
  }
  const t = (tools ?? {}) as Record<string, unknown>;
  const g = (r: string) => [geminiGrant(r)];
  return [
    ...listRules(src, t.allowed, "allow", g),
    ...listRules(src, t.exclude, "deny", g),
    ...geminiFlags(src, v),
  ];
}

function geminiSources(ctx: Ctx): Source[] {
  return [
    {
      harness: "Gemini CLI",
      scope: "user",
      abs: join(ctx.home, ".gemini", "settings.json"),
      file: "~/.gemini/settings.json",
    },
    { harness: "Gemini CLI", scope: "project", ...projectFile(ctx, ".gemini", "settings.json") },
    ...geminiSystemFiles(ctx.platform).map((abs) => ({
      harness: "Gemini CLI" as const,
      scope: "managed" as const,
      abs,
      file: abs,
    })),
  ];
}

function cursorSources(ctx: Ctx): Source[] {
  return [
    {
      harness: "Cursor CLI",
      scope: "user",
      abs: join(ctx.home, ".cursor", "cli-config.json"),
      file: "~/.cursor/cli-config.json",
    },
    { harness: "Cursor CLI", scope: "project", ...projectFile(ctx, ".cursor", "cli.json") },
  ];
}

/**
 * Every saved rule kit can read, in a fixed order: harness, then scope, then file order. A file
 * reached twice (kit run from the home directory) is read once, under its first scope.
 */
export function collectRules(ctx: Ctx): RawRule[] {
  const seen = new Set<string>();
  const once = (src: Source): boolean => {
    if (seen.has(src.abs)) return false;
    seen.add(src.abs);
    return true;
  };
  return [
    ...claudeSources(ctx).filter(once).flatMap(readClaude),
    ...codexSources(ctx).filter(once).flatMap(readCodex),
    ...cursorSources(ctx).filter(once).flatMap(readCursor),
    ...geminiSources(ctx).filter(once).flatMap(readGemini),
  ];
}
