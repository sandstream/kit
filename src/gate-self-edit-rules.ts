/**
 * `gate-self-edit` for permission rules, not only hooks (kit-research
 * `prismor-always-allowed-rules-vs-kit`, Measurement §2: an agent's Edit that deleted a kit deny rule
 * passed with exit 0, while an Edit that changed the gate hook in the same file was refused).
 *
 * - **Claude Code settings** (`.claude/settings.json`, `.claude/settings.local.json`,
 *   `~/.claude/settings.json`): a write is refused when it removes a deny rule of `KIT_DENY_RULES`
 *   that the file holds now, leaves a file that holds one unparseable or cannot be computed, or adds
 *   an allow rule that matches one of kit's deny rules (`kit-deny-rules.ts`). Claude Code applies
 *   deny before allow, so such an allow does nothing while the deny rule stays; it is still refused,
 *   because it is the half of an override an agent can stage first.
 * - **Codex rules** (`<repo>/.codex/rules/*.rules`, `~/.codex/rules/*.rules`, `$CODEX_HOME/rules`): a
 *   write is refused when it adds a `prefix_rule` whose decision is `allow`. Codex documents that
 *   `decision` defaults to `"allow"`, so a rule without one counts as an allow. A write whose result
 *   cannot be computed is refused too. Fail closed: Codex runs an allowed command outside its
 *   sandbox, and kit has no other layer that reads these files.
 *
 * Pure text functions; the caller reads the files and computes the resulting text.
 */
import { basename, dirname, resolve } from "node:path";

import { allowsOverridingKitDeny, heldKitDenyRules, permissionListsOf } from "./kit-deny-rules.js";

const PERSON =
  "a person changes kit's permission rules, not the agent (`kit agent-config` rewrites them)";

/** Why a write to a Claude Code settings file is refused for kit's deny rules, or null. */
export function denyRuleWriteRefusal(
  current: string | null,
  next: string | null,
  name: string,
  home: string,
): string | null {
  const before = current === null ? null : permissionListsOf(current);
  const held = heldKitDenyRules(before?.deny ?? []);
  const after = next === null ? null : permissionListsOf(next);
  if (held.length > 0 && next === null) {
    return `the edit to ${name} cannot be checked against kit's deny rules it holds`;
  }
  if (held.length > 0 && after === null) {
    return `the write would leave ${name} unparseable, which drops kit's deny rules`;
  }
  if (after === null) return null;
  const removed = held.filter((rule) => !after.deny.includes(rule));
  if (removed.length > 0) {
    return `the write would remove kit's deny rule(s) ${removed.join(", ")} from ${name}; ${PERSON}`;
  }
  const added = after.allow.filter((rule) => !(before?.allow ?? []).includes(rule));
  const override = allowsOverridingKitDeny(added, home)[0];
  if (override) {
    return `the write would add the allow rule ${override.allow} to ${name}, which matches kit's deny rule ${override.deny}; ${PERSON}`;
  }
  return null;
}

/** Whether a path is a Codex rules file: `.codex/rules/*.rules` anywhere, or `$CODEX_HOME/rules`. */
export function isCodexRulesPath(abs: string, codexHome: string | undefined): boolean {
  if (!/\.rules$/i.test(abs)) return false;
  const dir = dirname(abs);
  if (/^rules$/i.test(basename(dir)) && /^\.codex$/i.test(basename(dirname(dir)))) return true;
  return codexHome !== undefined && codexHome !== "" && sameDir(dir, resolve(codexHome, "rules"));
}

function sameDir(a: string, b: string): boolean {
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** The end index (exclusive) of the call whose `(` is at `open`, skipping quoted text. */
function callEnd(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Each `prefix_rule(...)` of a rules text whose decision is allow (or absent), whitespace-folded. */
export function codexAllowRules(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bprefix_rule\s*\(/g)) {
    const start = m.index ?? 0;
    const call = text.slice(start, callEnd(text, start + m[0].length - 1));
    const decision = /\bdecision\s*=\s*["']([^"']*)["']/.exec(call)?.[1];
    if (decision === undefined || decision === "allow") out.push(call.replace(/\s+/g, " "));
  }
  return out;
}

/** Why a write to a Codex rules file is refused, or null. `next` null: not computable. */
export function codexRulesWriteRefusal(
  current: string | null,
  next: string | null,
  name: string,
): string | null {
  if (next === null) return `the edit to ${name} cannot be checked for new allow rules`;
  const before = new Set(codexAllowRules(current ?? ""));
  const added = codexAllowRules(next).find((rule) => !before.has(rule));
  if (!added) return null;
  const shown = added.length > 120 ? `${added.slice(0, 117)}...` : added;
  return `the write would add an allow rule to ${name} (${shown}); Codex runs an allowed command without a prompt and outside its sandbox, so a person adds it, not the agent`;
}
