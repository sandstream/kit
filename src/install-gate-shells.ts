/**
 * Command text that a Windows shell runs, so the install gate can scan it like a top-level command.
 *
 * The gate already recurses into `sh -c '…'` and `bash -lc "…"`. `cmd /c npm install x`,
 * `powershell -c "npm install x"` and `pwsh -Command "pip install x"` passed silently: kit-research
 * `clickfix-vs-kit-install-gate` measured all three as BREAK. kit ships to native Windows, where
 * these are the ordinary shells.
 *
 * Read without execution or expansion, bounded per line. When the boundary between a flag's value
 * and the command is unknown, every candidate is returned: an extra scan can only block more.
 */

const MAX_TEXT = 4000;
// The binary, optionally path-qualified (`C:\Windows\System32\cmd.exe`), at a command head.
// Windows names are case-insensitive.
const WINDOWS_SHELL_HEAD =
  /(?:^|[\s;&|(])(?:[^\s;&|(]*[\\/])?(cmd|powershell|pwsh)(?:\.exe)?(?=\s|$)/gi;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function unquote(text: string): string {
  const t = text.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.length > 1 && t.endsWith(q)) return t.slice(1, -1);
  return t;
}

/** Everything after the first `/c` or `/k` among cmd's leading switches, glued (`/q/c`) or not. `/s` quote rules: strip one pair. */
function cmdBodies(rest: string): string[] {
  const match = rest.match(/^((?:\s*\/(?![ck])[a-z](?::[^\s/]*)?)*)\s*\/[ck](.*)$/is);
  if (!match) return [];
  const body = match[2]!.trim();
  return body ? [body, unquote(body)] : [];
}

/** A PowerShell parameter token, `-Name` or `/Name`, lower-cased without its prefix. */
function param(token: string): string | null {
  return /^[-/][A-Za-z]/.test(token) ? token.slice(1).toLowerCase() : null;
}

/** PowerShell accepts any prefix of a parameter name. `-c` is `-Command`, `-e` / `-ec` encoded. */
const isCommand = (name: string) => "command".startsWith(name);
const isEncoded = (name: string) => name === "ec" || "encodedcommand".startsWith(name);

function decodeEncoded(token: string | undefined): string[] {
  const b64 = unquote(token ?? "");
  if (!b64 || b64.length > MAX_TEXT || !BASE64.test(b64)) return [];
  // -EncodedCommand is base64 of UTF-16LE text.
  const text = Buffer.from(b64, "base64").toString("utf16le").replace(/\0/g, "");
  return text.trim() ? [text] : [];
}

/**
 * The script text `powershell` / `pwsh` runs. `-Command` and `-EncodedCommand` (any prefix, `-` or
 * `/`) for both. A bare first argument is a command for Windows PowerShell only (pwsh's default is
 * `-File`), and since a flag's value is not known to be one, both readings are returned.
 */
function powershellBodies(rest: string, windowsPowerShell: boolean): string[] {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const tail = (from: number) => tokens.slice(from).join(" ");
  for (let i = 0; i < tokens.length; i++) {
    const name = param(tokens[i]!);
    if (name === null) {
      // After a parameter this may be its value (`-w hidden`): already read both ways, go on.
      if (i > 0 && param(tokens[i - 1]!) !== null) continue;
      if (windowsPowerShell) out.push(tail(i), unquote(tail(i)));
      break;
    }
    if (name === "file" || name === "f") break; // a script file: not command text
    if (isCommand(name)) {
      const body = tail(i + 1);
      if (body) out.push(body, unquote(body));
      break;
    }
    if (isEncoded(name)) {
      out.push(...decodeEncoded(tokens[i + 1]));
      break;
    }
    // Any other parameter may take a value. If it does not, the next token is the command.
    const next = tokens[i + 1];
    if (windowsPowerShell && next !== undefined && param(next) === null)
      out.push(tail(i + 1), unquote(tail(i + 1)));
  }
  return out;
}

/** Command text run by `cmd /c|/k` or `powershell`/`pwsh` anywhere in `command`. Pure. */
export function windowsShellBodies(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(WINDOWS_SHELL_HEAD)) {
    const start = m.index + m[0].length;
    const lineEnd = command.indexOf("\n", start);
    const rest = command.slice(start, lineEnd < 0 ? undefined : lineEnd).slice(0, MAX_TEXT);
    const shell = m[1]!.toLowerCase();
    if (shell === "cmd") out.push(...cmdBodies(rest));
    else out.push(...powershellBodies(rest, shell === "powershell"));
  }
  return [...new Set(out.filter((body) => body.trim()))];
}
