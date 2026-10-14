/**
 * `kit statusline` — one compact, fast, read-only line for visible bars that can
 * run a command (Claude Code statusLine, a shell PS1, …): setup score for the
 * active mode + an "update available" mark + the open PAL count. Codex does not
 * expose that visible bar hook; its memory SessionStart hook injects the SAME text
 * as context instead. `--json` prints the same facts as one object for UI mods.
 *
 * Its own module so the generated flag surface admits `--json` for this verb only.
 */
import { flagValue } from "../utils/flags.js";

export async function cmdStatusline(): Promise<boolean> {
  process.env.KIT_NO_UPDATE_CHECK = "1"; // never let the post-command notice pollute the single line
  const { buildStatuslineParts } = await import("../statusline.js");
  const data = await buildStatuslineParts({ modeFlag: flagValue(process.argv, "--mode") });
  console.log(process.argv.includes("--json") ? JSON.stringify(data) : data.text);
  return true;
}
