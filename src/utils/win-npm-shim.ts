/**
 * Reads the program an npm-style Windows `.cmd` shim starts, so kit can run that program itself
 * with `execFile` and no shell.
 *
 * Why: on Windows an npm-installed CLI (`vercel`, `eas`, `wrangler`, `dotenvx`, the npm build of
 * `supabase`, …) is a `.cmd` batch shim. Node's `execFile` refuses a `.cmd`/`.bat` without a shell
 * (EINVAL, CVE-2024-27980), and a shell brings back the argument-injection surface `exec.ts`
 * exists to avoid. kit never runs a shim through a shell: it reads the shim as text, finds the
 * file it starts, and runs that file directly — a JS entry with kit's own `process.execPath`
 * (never a `node.exe` sitting next to the shim), or a native `.exe` as itself.
 *
 * The formats read (from the generators' sources, not guessed):
 * - npm `cmd-shim` ≥ 3 (npm 7+): `SET "_prog=%dp0%\node.exe"` / `SET "_prog=node"`, then
 *   `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\<target>" %*`.
 * - yarn v1 and npm `cmd-shim` < 3: `"%~dp0\node.exe"  "%~dp0\<target>" %*` and, in the ELSE
 *   branch, `node  "%~dp0\<target>" %*`.
 * - pnpm (`@zkochan/cmd-shim`): the yarn form, optionally with a `NODE_PATH`/`PATH` preamble, an
 *   absolute target, or an absolute `"C:\…\node.exe"` program.
 * - a target with no shebang (all three): `@"%~dp0\<target>"  %*` — the target runs itself; kit
 *   accepts that only when the target is an `.exe`.
 *
 * Refused, never approximated: interpreter arguments (a `--require` in a shebang would run code
 * kit did not hash), a program other than node, a target written with any other variable, two
 * invocations naming different targets, or text with no invocation at all.
 *
 * Pure: the caller reads the shim and resolves the result against its directory. Imports only
 * `node:` modules (ADR-0006).
 */
import { win32 } from "node:path";

/** What a shim starts: `node <target>` or the target itself. */
export interface ShimTarget {
  runner: "node" | "direct";
  /** `true`: `segments` are relative to the shim's directory. `false`: `absolute` is the target. */
  relative: boolean;
  segments: string[];
  absolute: string;
}

export type ShimParse = { ok: true; target: ShimTarget } | { ok: false; reason: string };

/** A `.cmd` or `.bat` file: what Node's `execFile` cannot start without a shell. */
export function isBatchFile(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

const NPM7_PREFIX =
  /^endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*/i;
const SHIM_DIR = /^(?:%~dp0|%dp0%)\\?/i;
const NODE_PROGRAMS = /^(?:node|node\.exe|%_prog%|(?:%~dp0|%dp0%)\\node\.exe)$/i;

/** Split one batch line into tokens: `"quoted"` (quotes kept off) or bare. Null on a stray quote. */
function tokens(line: string): string[] | null {
  const out: string[] = [];
  const re = /\s*(?:"([^"]*)"|([^\s"]+))/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2]!);
    at = re.lastIndex;
  }
  return line.slice(at).trim() === "" ? out : null;
}

function isNodeProgram(token: string): boolean {
  if (NODE_PROGRAMS.test(token)) return true;
  return win32.isAbsolute(token) && /^[a-z]:\\/i.test(token) && /\\node\.exe$/i.test(token);
}

/** The target a shim writes as `"%~dp0\…"`, `"%dp0%\…"` or an absolute drive path. */
function targetOf(raw: string): Omit<ShimTarget, "runner"> | string {
  if (SHIM_DIR.test(raw)) {
    const rest = raw.replace(SHIM_DIR, "");
    if (rest === "" || rest.includes("%")) return `target "${raw}" uses a variable kit cannot read`;
    const segments = rest.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
    return { relative: true, segments, absolute: "" };
  }
  if (raw.includes("%")) return `target "${raw}" uses a variable kit cannot read`;
  if (!/^[a-z]:\\/i.test(raw)) return `target "${raw}" is neither shim-relative nor absolute`;
  return { relative: false, segments: [], absolute: win32.normalize(raw) };
}

/** One invocation line (`… %*`) to a target, or a refusal reason. */
function parseInvocation(line: string): ShimTarget | string {
  const t = tokens(line.replace(/^@/, "").replace(NPM7_PREFIX, ""));
  if (!t || t.length < 2 || t.at(-1) !== "%*") return `cannot read invocation: ${line}`;
  const words = t.slice(0, -1);
  if (words.length === 1) {
    const target = targetOf(words[0]!);
    if (typeof target === "string") return target;
    const last = target.relative ? target.segments.at(-1)! : target.absolute;
    if (!/\.exe$/i.test(last)) return `the shim runs "${words[0]}" directly, which is not an .exe`;
    return { runner: "direct", ...target };
  }
  if (!isNodeProgram(words[0]!)) return `the shim runs "${words[0]}", not node`;
  if (words.length !== 2) return `the shim passes interpreter arguments: ${line}`;
  const target = targetOf(words[1]!);
  return typeof target === "string" ? target : { runner: "node", ...target };
}

/** npm ≥ 7: `SET "_prog=…"` must name node, or `"%_prog%"` could be anything. */
function progRefusal(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^@?set\s+"_prog=([^"]*)"$/i.exec(line);
    if (m && !isNodeProgram(m[1]!)) return `the shim sets _prog to "${m[1]}", not node`;
  }
  return null;
}

function sameTarget(a: ShimTarget, b: ShimTarget): boolean {
  const key = (t: ShimTarget) =>
    `${t.runner}|${t.relative}|${t.segments.join("\\")}|${t.absolute}`.toLowerCase();
  return key(a) === key(b);
}

/** Parse a shim's text. Every invocation line must agree on one target. */
export function parseNpmShim(text: string): ShimParse {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bad = progRefusal(lines);
  if (bad) return { ok: false, reason: bad };
  const calls = lines.filter((l) => /\s%\*$/.test(l));
  if (calls.length === 0) return { ok: false, reason: "no invocation line (… %*) found" };
  let found: ShimTarget | null = null;
  for (const line of calls) {
    const r = parseInvocation(line);
    if (typeof r === "string") return { ok: false, reason: r };
    if (found && !sameTarget(found, r)) return { ok: false, reason: "invocations disagree" };
    found = r;
  }
  return { ok: true, target: found! };
}

/** The target as a path, joined onto the shim's directory with the caller's `join`. */
export function shimTargetPath(
  target: ShimTarget,
  shimDir: string,
  join: (...parts: string[]) => string,
): string {
  return target.relative ? join(shimDir, ...target.segments) : target.absolute;
}
