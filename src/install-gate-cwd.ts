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
import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** Does `<cwd>/node_modules/.bin/<name>` exist? Exactly what a plain `npx <name>`
 *  resolves to before ever touching the registry. */
function hasLocalBin(cwd: string, name: string): boolean {
  if (existsSync(join(cwd, "node_modules", ".bin", name))) return true;
  return (
    process.platform === "win32" && existsSync(join(cwd, "node_modules", ".bin", `${name}.cmd`))
  );
}

/** Runner names a local `.bin` shadows, read in the directory npx runs in: none when the command
 *  may change directory first, because the hook's cwd is then not that directory. */
export function shadowedBins(command: string, names: string[], cwd?: string): string[] {
  if (!cwd || mayChangeDirectory(command)) return [];
  return names.filter((name) => hasLocalBin(cwd, name));
}

/** True when `ref` (`npm:<name>[@version]`) names exactly `bare` — not merely a prefix
 *  (`npm:tsc-x` must not match `bare = "tsc"`). The version suffix always starts `@`,
 *  and a bare scoped name (`@scope/pkg`) never collides with that. */
export function refIsBareName(ref: string, bare: string): boolean {
  const prefix = `npm:${bare}`;
  return ref === prefix || ref.startsWith(`${prefix}@`);
}
