/**
 * The Claude Code matcher of the `kit gate-bash` PreToolUse hook.
 *
 * Claude Code runs shell commands through two tools, `Bash` and `PowerShell`, and both send the
 * command at `tool_input.command`. Per https://code.claude.com/docs/en/hooks ("PowerShell" tool
 * input): "Match `Bash|PowerShell` in hooks that inspect shell commands, so they cover both tools
 * ... On Windows without Git Bash, the tool is enabled automatically and Claude Code doesn't
 * register the Bash tool at all. A hook that matches only `Bash` never fires there."
 *
 * kit wrote `Bash` alone until 2026-11, so an installed gate can be stale: `kit check` names it
 * through gate liveness, and `kit agent-config` widens it in place. Pure.
 */
import { commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import type { PreToolUseGroup } from "./gate-settings.js";

/** The matcher kit writes for `gate-bash`: an exact-name list, not a regular expression. */
export const GATE_BASH_MATCHER = "Bash|PowerShell";

/** The Claude Code tools that run shell commands. */
const SHELL_TOOLS = ["Bash", "PowerShell"] as const;

/**
 * Does a Claude Code matcher select `tool`? The documented rules ("Matcher patterns"): `*`, `""` or
 * omitted match all; letters, digits, `_`, `-`, spaces, `,` and `|` only is a list of exact names
 * split on `|` or `,`; anything else is an unanchored JavaScript regular expression.
 */
export function matcherSelects(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[\w\- ,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).some((name) => name.trim() === tool);
  }
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false; // an invalid pattern selects nothing
  }
}

const isGateBash = (hook: { command?: unknown }): boolean =>
  typeof hook.command === "string" && commandIncludesSubcommand(hook.command, "gate-bash");
const holdsGateBash = (g: PreToolUseGroup): boolean => (g.hooks ?? []).some(isGateBash);
const coversShells = (g: PreToolUseGroup): boolean =>
  SHELL_TOOLS.every((tool) => matcherSelects(g.matcher, tool));

/** The matchers of `gate-bash` groups that miss a Claude Code shell tool. */
export function staleGateBashMatchers(groups: PreToolUseGroup[]): string[] {
  return groups.filter((g) => holdsGateBash(g) && !coversShells(g)).map((g) => g.matcher ?? "");
}

/**
 * Widen every stale `gate-bash` group in place so `gate-bash` runs for both shell tools, once.
 * A group holding only kit's gate takes the new matcher. A gate that shares its group with other
 * hooks moves to a group of its own, so those hooks keep their matcher. A gate that another group
 * already covers is dropped rather than duplicated. Returns whether anything changed.
 */
export function widenGateBashMatchers(groups: PreToolUseGroup[]): boolean {
  const stale = groups.filter((g) => holdsGateBash(g) && !coversShells(g));
  let home = groups.find((g) => holdsGateBash(g) && coversShells(g));
  for (const group of stale) {
    const hooks = group.hooks ?? [];
    if (!home && hooks.every(isGateBash)) {
      group.matcher = GATE_BASH_MATCHER;
      home = group;
      continue;
    }
    group.hooks = hooks.filter((h) => !isGateBash(h));
    if (!home) {
      home = { matcher: GATE_BASH_MATCHER, hooks: hooks.filter(isGateBash) };
      groups.push(home);
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (stale.includes(groups[i]) && (groups[i].hooks ?? []).length === 0) groups.splice(i, 1);
  }
  return stale.length > 0;
}
