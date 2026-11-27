/**
 * kit's own Claude Code deny rules (`KIT_DENY_RULES`, written by `kit agent-config`) read back from
 * a settings file, and the allow rules that would undo one of them.
 *
 * kit-research `prismor-always-allowed-rules-vs-kit` measured that removing five of the twelve
 * rules and adding three allows to `.claude/settings.local.json` changed no `kit check` row and
 * passed every gate. This module is the shared reading for the `deny rule liveness` row and for
 * `gate-self-edit`.
 *
 * Claude Code evaluates deny rules before allow rules, in every scope
 * (https://code.claude.com/docs/en/permissions, "Manage permissions"). So an allow that matches a
 * kit deny rule is inert while that deny rule is present, and takes effect the moment it goes.
 *
 * "Matches" is decided on a witness: one concrete call each deny rule refuses (`git push origin
 * main --force`, `~/.ssh/id_ed25519`). An allow rule of the same tool that would let the witness
 * through matches. Bash patterns follow the documented forms (`*` for any text, the legacy `:*`
 * prefix suffix, a bare tool name for every call); Read patterns follow the documented path forms
 * (`~/`, `//` absolute, `/` and `./` project-relative, a name without `/` at any depth, `*`, `**`).
 * The matcher is text only and never runs anything.
 */
import { homedir } from "node:os";

import { ENV_EXAMPLE_CARVE_OUT, KIT_DENY_RULES } from "./agent-config-strict.js";

/** The `permissions` lists of a Claude Code settings file. */
export interface PermissionLists {
  allow: string[];
  deny: string[];
}

/** An allow rule and the kit deny rule whose witness it lets through. */
export interface DenyOverride {
  allow: string;
  deny: string;
}

/** One call each kit deny rule refuses. `~` is the home directory; the rest is project-relative. */
const WITNESSES: Record<string, { tool: "Read" | "Bash"; call: string }> = {
  "Read(~/.ssh/**)": { tool: "Read", call: "~/.ssh/id_ed25519" },
  "Read(~/.aws/**)": { tool: "Read", call: "~/.aws/credentials" },
  "Read(~/.gnupg/**)": { tool: "Read", call: "~/.gnupg/private-keys-v1.d/key.key" },
  "Read(~/.config/gcloud/**)": { tool: "Read", call: "~/.config/gcloud/credentials.db" },
  "Read(.env)": { tool: "Read", call: ".env" },
  "Read(.env.*)": { tool: "Read", call: ".env.production" },
  "Bash(git push *--force*)": { tool: "Bash", call: "git push origin main --force" },
  "Bash(git push -f*)": { tool: "Bash", call: "git push -f origin main" },
  "Bash(git push * -f*)": { tool: "Bash", call: "git push origin main -f" },
  "Bash(git push * +*)": { tool: "Bash", call: "git push origin +main" },
  "Bash(git reset *--hard*)": { tool: "Bash", call: "git reset --hard HEAD~1" },
};

/** The kit deny rules that refuse a call. The `.env.example` carve-out refuses nothing. */
export const KIT_REFUSING_DENY_RULES = KIT_DENY_RULES.filter((r) => r !== ENV_EXAMPLE_CARVE_OUT);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** `permissions.allow` and `permissions.deny` of a settings text; null when it is not an object. */
export function permissionListsOf(text: string): PermissionLists | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const perms = (doc as { permissions?: { allow?: unknown; deny?: unknown } }).permissions;
  return { allow: strings(perms?.allow), deny: strings(perms?.deny) };
}

/** The kit deny rules a deny list does not hold, in kit's order. */
export function missingKitDenyRules(deny: readonly string[]): string[] {
  return KIT_DENY_RULES.filter((rule) => !deny.includes(rule));
}

/** The kit deny rules a deny list holds. */
export function heldKitDenyRules(deny: readonly string[]): string[] {
  return KIT_DENY_RULES.filter((rule) => deny.includes(rule));
}

function parseRule(rule: string): { tool: string; spec: string | null } | null {
  const m = /^\s*([A-Za-z]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
  return m ? { tool: m[1], spec: m[2] ?? null } : null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** A glob as a regex source: `**` any text, `*` any text (Bash) or one path segment (Read). */
function globSource(glob: string, star: string): string {
  return glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return star;
      if (part === "?") return "[^/]";
      return escapeRegex(part);
    })
    .join("");
}

function bashAllows(spec: string, call: string): boolean {
  const pattern = spec.trim();
  if (pattern.endsWith(":*")) return call.startsWith(pattern.slice(0, -2));
  return new RegExp(`^${globSource(pattern, ".*")}$`).test(call);
}

const caseFlag = (): string =>
  process.platform === "win32" || process.platform === "darwin" ? "i" : "";

/** A Read pattern and a witness path, both with the home directory spelled out and `/` only. */
function readAllows(spec: string, call: string, home: string): boolean {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const h = slash(home).replace(/\/+$/, "");
  const path = call.startsWith("~/") ? `${h}/${call.slice(2)}` : call;
  let pattern = slash(spec.trim());
  if (pattern.startsWith("~/")) pattern = `${h}/${pattern.slice(2)}`;
  else if (pattern.startsWith("//")) pattern = pattern.slice(1);
  else if (pattern.startsWith("./")) pattern = pattern.slice(2);
  else if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const flags = caseFlag();
  if (!pattern.replace(/\/$/, "").includes("/")) {
    const base = path.split("/").pop() ?? path;
    const anyDepth = new RegExp(`^${globSource(pattern, "[^/]*")}$`, flags);
    return anyDepth.test(base);
  }
  return new RegExp(`^${globSource(pattern, "[^/]*")}$`, flags).test(path);
}

/** Whether an allow rule lets the witness of a kit deny rule through. */
export function allowMatchesDeny(allow: string, deny: string, home: string = homedir()): boolean {
  const witness = WITNESSES[deny];
  const rule = parseRule(allow);
  if (!witness || !rule || rule.tool !== witness.tool) return false;
  if (rule.spec === null || rule.spec.trim() === "" || rule.spec.trim() === "*") return true;
  return witness.tool === "Bash"
    ? bashAllows(rule.spec, witness.call)
    : readAllows(rule.spec, witness.call, home);
}

/** Each allow rule that matches a kit deny rule, paired with that rule. */
export function allowsOverridingKitDeny(
  allow: readonly string[],
  home: string = homedir(),
): DenyOverride[] {
  const out: DenyOverride[] = [];
  for (const a of allow) {
    for (const deny of KIT_REFUSING_DENY_RULES) {
      if (allowMatchesDeny(a, deny, home)) out.push({ allow: a, deny });
    }
  }
  return out;
}
