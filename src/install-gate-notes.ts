/**
 * What an install runs that the gate does not triage, named on its verdict.
 *
 * The bash gate passed a remote script from a non-GitHub host fed to a shell, and a bare
 * `npm install` / `npm ci`, with no output (kit-research `binance-2026-10-29-incident-vs-kit`). A
 * bare install runs the install scripts of every locked package and the project's own lifecycle
 * scripts. The owner chose to name these, not to change what is allowed: a note goes on the allow
 * and on the refusal, and no rule here blocks anything.
 *
 * Read without execution: the command text, `package.json` and `package-lock.json`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { installDirectory, type BareSegment } from "./install-gate-bare.js";

const SHELL = "(?:sh|bash|zsh|dash|ksh|ash|fish)";
const URL = "(https?:\\/\\/[^\\s'\"`<>|;&)]+)";
// `curl … <url> … | bash`, the pipe form.
const PIPED = new RegExp(
  `\\b(?:curl|wget)\\b[^\\n|;&]{0,2000}?${URL}[^\\n|;&]{0,2000}\\|\\s*(?:(?:sudo|doas|env|command)\\s+(?:[^\\s=]+=\\S+\\s+)*)?(?:\\S*\\/)?(${SHELL})\\b`,
  "g",
);
// `bash -c "$(curl … <url>)"` and `bash <(curl … <url>)`, the substitution forms.
const SUBSTITUTED = new RegExp(
  `(?:^|[\\s;&|(])(?:\\S*\\/)?(${SHELL})\\s+(?:-\\w+\\s+)*["']?(?:\\$|<)\\(\\s*(?:curl|wget)\\b[^)]{0,2000}?${URL}`,
  "g",
);

const GITHUB = /^https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\//i;

/** Lifecycle scripts `npm install` runs from the project's own package.json. */
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];
const MAX_NAMED = 8;
const MAX_FILE = 50 * 1024 * 1024;

/** Each remote script that `command` feeds to a shell, as `<url> (run by <shell>)`. Pure. */
export function remoteScripts(command: string): string[] {
  if (!command || command.length > 100_000) return [];
  const found: string[] = [];
  for (const m of command.matchAll(PIPED)) found.push(`${m[1]} (run by ${m[2]})`);
  for (const m of command.matchAll(SUBSTITUTED)) found.push(`${m[2]} (run by ${m[1]})`);
  return [...new Set(found)];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_FILE) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The project's own lifecycle scripts, by name. */
function ownScripts(dir: string): string[] {
  const scripts = readJson(join(dir, "package.json"))?.scripts;
  if (scripts === null || typeof scripts !== "object") return [];
  return LIFECYCLE.filter((name) => typeof (scripts as Record<string, unknown>)[name] === "string");
}

/** Locked packages npm marks `hasInstallScript`, by name; null when there is no npm lockfile. */
function lockedInstallScripts(dir: string): string[] | null {
  const lock =
    readJson(join(dir, "package-lock.json")) ?? readJson(join(dir, "npm-shrinkwrap.json"));
  const packages = lock?.packages;
  if (packages === null || typeof packages !== "object") return null;
  const names = new Set<string>();
  for (const [path, entry] of Object.entries(packages as Record<string, unknown>)) {
    if (!path || (entry as { hasInstallScript?: unknown })?.hasInstallScript !== true) continue;
    names.add(path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length));
  }
  return [...names].sort();
}

function listed(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED).join(", ");
  return names.length > MAX_NAMED ? `${shown} and ${names.length - MAX_NAMED} more` : shown;
}

/** A note for a package-less install, naming the scripts it runs, or null. */
export function bareInstallNote(
  command: string,
  cwd: string,
  segments: BareSegment[],
): string | null {
  const scriptsOff = segments.every((s) => s.tokens.includes("--ignore-scripts"));
  if (segments.length === 0 || scriptsOff) return null;
  const manager = segments.map((s) => s.tokens.slice(0, 2).join(" ")).join(", ");
  const where = installDirectory(command, cwd, segments);
  if ("unresolved" in where) return `bare install (${manager}) runs lifecycle scripts`;
  const own = ownScripts(where.dir);
  // Only npm's lockfile records `hasInstallScript`, and only npm installs from it.
  const npm = segments.every((s) => s.manager === "npm");
  const locked = npm ? lockedInstallScripts(where.dir) : null;
  const parts = [
    own.length ? `the project's ${own.join(", ")}` : "",
    locked === null
      ? "install scripts of dependencies (no npm lockfile in use records which)"
      : locked.length
        ? `install scripts of ${locked.length} locked package(s): ${listed(locked)}`
        : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `bare install (${manager}) in ${where.dir} runs ${parts.join("; ")}`;
}

/** Every note for `command`: remote scripts and bare installs. */
export function installNotes(
  command: string,
  cwd: string | undefined,
  segments: BareSegment[],
): string[] {
  const notes = remoteScripts(command).map((s) =>
    GITHUB.test(s)
      ? `remote script, triaged as its GitHub repository: ${s}`
      : `remote script, not triaged: ${s}`,
  );
  const bare = cwd ? bareInstallNote(command, cwd, segments) : null;
  return bare ? [...notes, bare] : notes;
}

/** `verdict` with `notes` added: in the reason of a refusal, as `notes` on an allow. */
export function withNotes<V extends { block: boolean; reason: string; notes?: string[] }>(
  verdict: V,
  notes: string[],
): V {
  if (notes.length === 0) return verdict;
  if (!verdict.block) return { ...verdict, notes };
  return { ...verdict, reason: `${verdict.reason}. The command also runs: ${notes.join("; ")}` };
}
