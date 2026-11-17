/**
 * Whether a shell command may run its package runner somewhere other than the hook's directory.
 *
 * The npx shadow check drops `npx <name>` when `node_modules/.bin/<name>` exists in the hook's
 * cwd, because npx runs that local binary. `cd '../other' && npx <name>` runs in another
 * directory, where no local binary exists and npx fetches the registry package of that name, so
 * the check read the wrong directory and let it through untriaged (kit-research
 * claude-code-code-mode-vs-kit). When the directory can change, the shadow does not apply.
 *
 * Read without execution, conservatively: any directory change anywhere in the command counts.
 */
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

const DIR_CHANGERS = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
const DIR_FLAGS = /^--(prefix|cwd|dir)(=|$)|^-C$/;

export function mayChangeDirectory(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment).map(shellWordValue);
    if (words.length > 0 && DIR_CHANGERS.has(words[0]!.toLowerCase())) return true;
    if (words.some((w) => DIR_FLAGS.test(w))) return true;
  }
  return false;
}
