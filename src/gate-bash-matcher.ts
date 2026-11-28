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
 * through gate liveness, and `kit agent-config` widens it in place.
 *
 * The opt-in `kit gate-egress` reads shell commands too (PowerShell's `Invoke-WebRequest` among
 * them) and was also installed with `Bash` alone, so the same reading and repair cover it, keyed on
 * its own subcommand; `kit agent-config --broker-gate` widens it.
 *
 * `gate-bash` also runs in a group of its own whose matcher selects the MCP tools that start or
 * steer another agent (`ORCHESTRATION_MCP_MATCHER`, src/orchestration-mcp-tools.ts). That group is
 * not a shell group: it is never reported stale for missing a shell tool, and never widened.
 */
import { resolve } from "node:path";
import { commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import { groupsIn, preToolUseGroups, type PreToolUseGroup } from "./gate-settings.js";
import { userSettingsPath } from "./gate-liveness-user.js";
import { ORCHESTRATION_MCP_MATCHER } from "./orchestration-mcp-tools.js";

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

/** The kit gates that read a shell command, and so need both Claude Code shell tools. */
export type ShellGate = "gate-bash" | "gate-egress";

const isGate =
  (sub: ShellGate) =>
  (hook: { command?: unknown }): boolean =>
    typeof hook.command === "string" && commandIncludesSubcommand(hook.command, sub);
const holdsGate = (sub: ShellGate) => (g: PreToolUseGroup) =>
  g.matcher !== ORCHESTRATION_MCP_MATCHER && (g.hooks ?? []).some(isGate(sub));
const coversShells = (g: PreToolUseGroup): boolean =>
  SHELL_TOOLS.every((tool) => matcherSelects(g.matcher, tool));

/** The matchers of a shell gate's groups that miss a Claude Code shell tool. */
export function staleShellGateMatchers(
  groups: PreToolUseGroup[],
  sub: ShellGate = "gate-bash",
): string[] {
  const holds = holdsGate(sub);
  return groups.filter((g) => holds(g) && !coversShells(g)).map((g) => g.matcher ?? "");
}

/** The matchers of `gate-bash` groups that miss a Claude Code shell tool. */
export function staleGateBashMatchers(groups: PreToolUseGroup[]): string[] {
  return staleShellGateMatchers(groups, "gate-bash");
}

/**
 * Stale `gate-bash` matchers in the project's `.claude/settings*.json` and the user-level
 * `~/.claude/settings.json`, each once.
 */
export function staleGateBashMatchersFor(
  cwd: string,
  home?: string,
  sub: ShellGate = "gate-bash",
): string[] {
  const project = preToolUseGroups(resolve(cwd, ".claude", "settings.json"));
  const user = groupsIn(userSettingsPath(home));
  return [...new Set(staleShellGateMatchers([...project, ...user], sub))];
}

/**
 * The `enforcement gate liveness` failure for a stale shell-gate matcher, or null. `gate-bash` is
 * checked where it is wired; the opt-in `gate-egress` only where it is wired.
 */
export function staleShellGateDetail(
  cwd: string,
  wired: { installGate: boolean; egressGate: boolean },
  home?: string,
): string | null {
  const parts: string[] = [];
  const repair = new Set<string>();
  const gates: [ShellGate, string, boolean, string][] = [
    ["gate-bash", "install-gate (gate-bash)", wired.installGate, "kit agent-config"],
    [
      "gate-egress",
      "egress gate (gate-egress)",
      wired.egressGate,
      "kit agent-config --broker-gate",
    ],
  ];
  for (const [sub, label, isWired, fix] of gates) {
    const stale = isWired ? staleGateBashMatchersFor(cwd, home, sub) : [];
    if (stale.length === 0) continue;
    parts.push(`${label} matcher ${stale.map((m) => JSON.stringify(m)).join(", ")}`);
    repair.add(fix);
  }
  if (parts.length === 0) return null;
  return `${parts.join("; ")} does not select both of Claude Code's shell tools (Bash, PowerShell), so a command run through the missing one is not gated. Run: ${[...repair].join(" and ")}`;
}

/**
 * Widen every stale `gate-bash` group in place so `gate-bash` runs for both shell tools, once.
 * A group holding only kit's gate takes the new matcher. A gate that shares its group with other
 * hooks moves to a group of its own, so those hooks keep their matcher. A gate that another group
 * already covers is dropped rather than duplicated. Returns whether anything changed.
 */
export function widenGateBashMatchers(
  groups: PreToolUseGroup[],
  sub: ShellGate = "gate-bash",
): boolean {
  const isGateBash = isGate(sub);
  const holdsGateBash = holdsGate(sub);
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

/** `widenGateBashMatchers` for the opt-in egress gate. */
export const widenGateEgressMatchers = (groups: PreToolUseGroup[]): boolean =>
  widenGateBashMatchers(groups, "gate-egress");

/**
 * Add `hook` (kit's gate-bash) in a group of its own for the orchestration MCP tools, unless such a
 * group already runs gate-bash. Returns whether it added one.
 */
export function addOrchestrationGateGroup(
  groups: PreToolUseGroup[],
  hook: NonNullable<PreToolUseGroup["hooks"]>[number],
): boolean {
  const has = groups.some(
    (g) => g.matcher === ORCHESTRATION_MCP_MATCHER && (g.hooks ?? []).some(isGate("gate-bash")),
  );
  if (has) return false;
  groups.push({ matcher: ORCHESTRATION_MCP_MATCHER, hooks: [hook] });
  return true;
}
