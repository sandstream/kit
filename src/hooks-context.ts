/**
 * `kit hooks context`: the same check as `kit hooks check`, shaped for an agent's
 * session-start hook.
 *
 * The git-hook floor only exists after someone runs `kit hooks install` (or `kit fix`), and the
 * managed block asks for that in prose ("Start: `kit check` — on `fail`, run `kit fix`"). An agent
 * session in a fresh clone skipped that line for its whole length, so every commit it made went
 * through no hook (#671). A session-start hook is not skippable, but an agent only sees what such a
 * hook prints on a zero exit. So this mode always exits 0, prints nothing when the floor is intact,
 * and otherwise prints one plain line (no colour codes, they would land in the agent's context)
 * naming the hooks that do not run and the command that installs them. It never installs anything
 * itself: a session-start hook that writes to `.git/hooks` would be a side effect nobody approved.
 */
import {
  checkHooks,
  hookCheckStatus,
  isGitRepository,
  type HookCheckResult,
} from "./check-hooks.js";
import { loadConfig } from "./config.js";
import { resolveConfigPath } from "./cli-shared.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { isReadOnlyMode } from "./read-only-mode.js";
import { realDeps, watchSkillDeps, type WatchDeps } from "./skill-deps-watch.js";

/**
 * Lines about npm dependencies that skills carry (`~/.claude/skills/<name>/scripts`). Nothing
 * updates those on its own, so a session start is the moment to say that one has a known
 * vulnerability or is a major version behind. `KIT_SKILL_DEPS_WATCH=0` turns it off.
 */
export function skillDepsContext(
  env: NodeJS.ProcessEnv = process.env,
  deps: WatchDeps = realDeps,
  cwd: string = process.cwd(),
): string[] {
  if (env.KIT_SKILL_DEPS_WATCH === "0") return [];
  return watchSkillDeps(
    {
      roots: [join(homedir(), ".claude", "skills"), join(cwd, ".claude", "skills")],
      cache: join(homedir(), ".kit", "skill-deps-watch.json"),
      readOnly: isReadOnlyMode(),
    },
    deps,
  );
}

/** The line an agent should read, or null when every declared hook would run. */
export function hooksContextNote(results: HookCheckResult[]): string | null {
  const broken = results.filter((r) => hookCheckStatus(r) === "fail");
  if (broken.length === 0) return null;
  const what = broken
    .map((r) => {
      const why = !r.installed ? "not installed" : !r.executable ? "not executable" : "outdated";
      return `${r.hookName} (${why})`;
    })
    .join(", ");
  return (
    `kit: git hooks declared in .kit.toml do not run in this checkout: ${what}. ` +
    `Commits and pushes here are not gated until you run \`kit hooks install\`.`
  );
}

/** Print the note when there is one. Always true: a session-start hook must never fail. */
export async function runHooksContext(): Promise<true> {
  try {
    for (const note of skillDepsContext()) console.log(note);
  } catch {
    // A skill-dependency check that breaks must not break the session.
  }
  try {
    const config = await loadConfig(resolveConfigPath());
    if (!config.hooks || Object.keys(config.hooks).length === 0 || !isGitRepository()) return true;
    const note = hooksContextNote(await checkHooks(config.hooks));
    if (note) console.log(note);
  } catch {
    // No .kit.toml, an unreadable config or a broken repository: say nothing rather than
    // break the session. `kit hooks check` and `kit check` report those cases properly.
  }
  return true;
}
