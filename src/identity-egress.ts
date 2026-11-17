/**
 * Whether one pending agent tool call would send one of the user's own email addresses over the
 * network. Pure: reads the tool name, its input and the identity set; never runs or fetches.
 *
 * Claude Code once put the signed-in account's address into requests agents wrote themselves
 * (kit-research `claude-code-account-email-user-agent-vs-kit`). kit's other gates decide by
 * destination; this one decides by what the call carries.
 *
 *   - Carries: the address itself (case-insensitive), its percent-encoding (`%40`), or a shell
 *     substitution that reads it from git (`git config user.email`, `git log --format=%ae`).
 *   - Network-shaped: what `classifyToolCall` says (WebFetch, WebSearch, any `mcp__` tool, or a
 *     command or script that names a network client or request part).
 *   - A Write/Edit counts only when it writes a script (by extension or shebang): a script with a
 *     network call is refused when it is written, before it can run. Markdown, JSON and other
 *     data files are out of scope, so documentation about the leak is never refused.
 *
 * Only email addresses are checked. A git `user.name` is ordinary words too often to refuse on,
 * and a `users.noreply.github.com` address exists to be published.
 */
import type { Identity } from "./transcript-identity.js";
import { classifyToolCall } from "./transcript-identity-classify.js";

export interface IdentityEgressFinding {
  kind: Identity["kind"] | "git-substitution";
  tool: string;
  /** The destination `classifyToolCall` names: a host, `mcp:<server>`, `web-search` or `unknown`. */
  host: string;
}

const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".rb",
  ".pl",
  ".php",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".lua",
  ".r",
  ".ipynb",
]);

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Reading the git author into a command: the indirection a literal-only matcher misses. */
const GIT_IDENTITY_READ =
  /\bgit\s+(?:-c\s+\S+\s+)*(?:config\s+(?:--\S+\s+)*user\.email\b|log\b[^\n|;&]*%a[eE]\b|var\s+GIT_(?:AUTHOR|COMMITTER)_IDENT\b)/;

/** Addresses the gate never refuses: published on purpose. */
function isPublishable(address: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(address);
}

/** The file extension of a path, lower-cased, with either separator. */
function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Whether a write creates or changes a script: by extension, or a shebang on the first line. */
export function isScriptWrite(filePath: string, text: string): boolean {
  if (SCRIPT_EXTENSIONS.has(extensionOf(filePath))) return true;
  return extensionOf(filePath) === "" && text.startsWith("#!");
}

/** The text a write puts into a file; null for a non-write or a non-script write. */
function writtenScript(input: Record<string, unknown>): string | null {
  const filePath =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.notebook_path === "string" && input.notebook_path) ||
    "";
  const parts: string[] = [];
  for (const key of ["content", "new_string", "new_source"]) {
    if (typeof input[key] === "string") parts.push(input[key] as string);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const ns = (e as Record<string, unknown> | null)?.new_string;
      if (typeof ns === "string") parts.push(ns);
    }
  }
  const text = parts.join("\n");
  return filePath && isScriptWrite(filePath, text) ? text : null;
}

/** Which identity, if any, a text carries. */
function carried(text: string, ids: Identity[]): IdentityEgressFinding["kind"] | null {
  const lower = text.toLowerCase();
  for (const id of ids) {
    if (id.kind === "git-name" || isPublishable(id.value)) continue;
    const v = id.value.toLowerCase();
    if (lower.includes(v) || lower.includes(v.replace(/@/g, "%40"))) return id.kind;
  }
  return GIT_IDENTITY_READ.test(text) ? "git-substitution" : null;
}

export interface NetworkCall {
  tool: string;
  /** The text the call would send: a script as written, or the input with newlines restored. */
  text: string;
  /** The destination `classifyToolCall` names: a host, `mcp:<server>`, `web-search` or `unknown`. */
  host: string;
}

/**
 * The pending tool call as a network call, or null when it is not network-shaped (or is a write
 * of something other than a script). `input` is the hook payload's `tool_input`. Needs no
 * identity, so a gate can stop here without reading git or `~/.claude.json`.
 */
export function networkCall(tool: string, input: unknown): NetworkCall | null {
  const fields = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // A script is checked as written; any other input as JSON with its newlines restored, so a
  // `From:` header on its own line reads as one.
  const text = WRITE_TOOLS.has(tool)
    ? writtenScript(fields)
    : JSON.stringify(fields).replace(/\\n/g, "\n");
  if (text === null) return null;
  const shape = classifyToolCall(tool, text);
  return shape.network ? { tool, text, host: shape.host ?? "unknown" } : null;
}

/** The finding for a network call that carries one of the user's addresses; null when none. */
export function identityEgress(call: NetworkCall, ids: Identity[]): IdentityEgressFinding | null {
  const kind = carried(call.text, ids);
  return kind ? { kind, tool: call.tool, host: call.host } : null;
}
