/**
 * Gates wired at user level. `kit agent-config --user` writes `gate-bash` and `gate-env` into
 * `~/.claude/settings.json`, which Claude Code applies in every project on the machine. The
 * liveness row reads only the project's `.claude/settings*.json`, so a checkout gated from the
 * user file looked ungated. This folds the user file's gates into the project view.
 *
 * Only `settings.json` is read: Claude Code has no user-level `settings.local.json`.
 * The home directory comes from `os.homedir()` (HOME on POSIX, USERPROFILE on Windows).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { groupsIn } from "./gate-settings.js";
import { staleGateBashMatchers } from "./gate-bash-matcher.js";
import {
  GATE_SUBCOMMANDS,
  commandIncludesSubcommand,
  hookCommandProblems,
} from "./agent-config-hook-liveness.js";
import type { GateLiveness } from "./agent-config.js";

/** The user-level Claude Code settings file. */
export function userSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

/** kit gate commands in the user-level PreToolUse hooks. */
export function userGateCommands(home: string = homedir()): string[] {
  return groupsIn(userSettingsPath(home))
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command)
    .filter((cmd): cmd is string => typeof cmd === "string")
    .filter((cmd) => GATE_SUBCOMMANDS.some((sub) => commandIncludesSubcommand(cmd, sub)));
}

/**
 * The project's gate liveness with the user-level gates added. A kit gate in the user file means
 * kit gated this machine, so it counts as installed; a user file with one gate and not the other
 * is a hole, as it is in a project file. A user gate that cannot start is a problem here too.
 */
export function withUserGates(live: GateLiveness, home: string = homedir()): GateLiveness {
  const commands = userGateCommands(home);
  if (commands.length === 0) return live;
  const has = (sub: string) => commands.some((cmd) => commandIncludesSubcommand(cmd, sub));
  return {
    everInstalled: true,
    installGate: live.installGate || has("gate-bash"),
    envGate: live.envGate || has("gate-env"),
    egressGate: live.egressGate || has("gate-egress"),
    problems: [...live.problems, ...commands.flatMap((cmd) => hookCommandProblems(cmd))],
    staleMatchers: [
      ...(live.staleMatchers ?? []),
      ...staleGateBashMatchers(groupsIn(userSettingsPath(home))),
    ],
  };
}
