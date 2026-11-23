/**
 * The hooks of the project's `.claude/settings.json`, as profile components.
 *
 * `kit profile` listed skills, MCP servers and plugins, and reported one that was added. A hook
 * was in none of the lists, although the harness runs it on its own, outside every tool-call gate
 * (kit-research `agent-platform-2027-vs-kit`). With hooks in the profile, `kit profile check`
 * reports a hook that was added or removed, and one whose script file changed.
 *
 * - **Name:** `<event>: <command>`, with the matcher after the event when there is one
 *   (`PreToolUse[Bash]: …`). The command is the identity: a changed command is a removed hook
 *   and an added one.
 * - **Version:** the first 16 hex digits of a SHA-256 over the project script files the command
 *   names, in the order it names them. No version when it names none, or one cannot be read.
 * - **Scope:** `.claude/settings.json` only. `.claude/settings.local.json` and
 *   `~/.claude/settings.json` belong to one machine, and the profile travels between machines.
 *   `kit check` and the gates cover those two.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scriptPaths } from "../agent-hook-scripts.js";
import type { DiscoveredComponent } from "./reconcile.js";

interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
}

function scriptsDigest(root: string, command: string): string | undefined {
  const files = scriptPaths(command);
  if (files.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const rel of files) {
    try {
      hash
        .update(rel)
        .update("\0")
        .update(readFileSync(resolve(root, rel)));
    } catch {
      return undefined;
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function entryName(event: string, group: HookGroup, hook: unknown): string {
  const matcher = typeof group.matcher === "string" && group.matcher ? `[${group.matcher}]` : "";
  const command = (hook as { command?: unknown } | null)?.command;
  return `${event}${matcher}: ${typeof command === "string" ? command : JSON.stringify(hook)}`;
}

/** Hook components of a settings.json text, sorted by name, one per distinct name. Pure but for script reads. */
export function hooksFromSettings(text: string, root: string): DiscoveredComponent[] {
  let hooks: unknown;
  try {
    hooks = (JSON.parse(text) as { hooks?: unknown } | null)?.hooks;
  } catch {
    return [];
  }
  if (!hooks || typeof hooks !== "object") return [];
  const byName = new Map<string, DiscoveredComponent>();
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    for (const group of (Array.isArray(groups) ? groups : []) as HookGroup[]) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        const name = entryName(event, group, hook);
        const command = (hook as { command?: unknown } | null)?.command;
        const version = typeof command === "string" ? scriptsDigest(root, command) : undefined;
        byName.set(name, version ? { name, version } : { name });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The hooks the project's `.claude/settings.json` wires; empty when there is no such file. */
export function discoverHooks(cwd: string): DiscoveredComponent[] {
  try {
    return hooksFromSettings(readFileSync(join(cwd, ".claude", "settings.json"), "utf-8"), cwd);
  } catch {
    return [];
  }
}
