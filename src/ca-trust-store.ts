/**
 * A change to the machine's trusted root certificates.
 *
 * `update-ca-certificates`, `security add-trusted-cert … System.keychain` and `certutil -addstore
 * Root` make every program on the machine trust whoever holds the new root's key, not only this
 * project's traffic. ARTEX-CC's `init` prints all three for its MITM proxy CA, and `gate-bash`
 * passed each with exit 0 (kit-research `artex-cc-vs-kit`). The change is durable, usually made
 * with `sudo`, and is not an install, so no other gate reads it. The gate names it and asks for the
 * person, the way it does for a command that cannot be undone: there is no agent-side allow.
 *
 * Out of scope: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and similar variables.
 * They change trust for one process tree, not the machine, and agents set them for corporate
 * proxies every day.
 *
 * Read without execution, like `install-gate-hooks`. Quoted text is data unless a shell runs it
 * (`sh -c '…'`, `$(…)`, `powershell -Command`), which is read again, to a bounded depth.
 */
import { bin, MAX_DEPTH, SHELLS, WRAPPERS } from "./install-gate-hooks.js";
import { windowsShellBodies } from "./install-gate-shells.js";
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

// Directories whose files become trusted roots at the next store refresh.
const ANCHOR_DIRS = [
  "/usr/local/share/ca-certificates", // Debian, Ubuntu, Alpine (update-ca-certificates)
  "/etc/pki/ca-trust/source/anchors", // Fedora, RHEL (update-ca-trust)
  "/usr/share/pki/ca-trust-source/anchors", // Fedora, RHEL, vendor anchors
  "/etc/ca-certificates/trust-source/anchors", // Arch (trust / update-ca-trust)
  "/etc/pki/trust/anchors", // SUSE (update-ca-certificates)
];
// Copiers whose LAST operand (or `-t DIR`) is the destination. `tee` and `dd of=` are read apart.
const COPIERS = new Set(["cp", "mv", "install", "ln", "rsync"]);
const FILE_WRITERS = new Set([...COPIERS, "tee", "dd"]);
// Windows certificate stores whose entries are trusted roots.
const ROOT_STORES = new Set(["root", "authroot"]);
// Separators optional: an unquoted `\L` loses its backslash when the text is read as POSIX shell.
const CERT_STORE_PATH = /^cert:[\\/]*(localmachine|currentuser)[\\/]*(auth)?root[\\/]*$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "("]);

type Check = (args: string[]) => string | null;

const helpOnly = (args: string[]) => args.some((a) => /^(-h|--help|-\?)$/.test(a));
const subcommand = (args: string[]) => args.find((a) => !a.startsWith("-"));

function anchorPath(word: string): boolean {
  const path = word.replace(/\/+/g, "/");
  return ANCHOR_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** `certutil -addstore [-f] Root x.crt`, in any order, with `-` or `/`. */
function certutil(args: string[]): string | null {
  const lower = args.map((a) => a.toLowerCase());
  if (!lower.some((a) => a === "-addstore" || a === "/addstore")) return null;
  const store = lower.find((a) => ROOT_STORES.has(a));
  return store ? `certutil -addstore ${store === "root" ? "Root" : "AuthRoot"}` : null;
}

/** `Import-Certificate -CertStoreLocation Cert:\LocalMachine\Root` (and the PFX form). */
function importCertificate(head: string): Check {
  return (args) => {
    const values = args.map((a) => a.replace(/^-[A-Za-z]+:/, ""));
    const store = values.find((a) => CERT_STORE_PATH.test(a));
    return store ? `${head} -CertStoreLocation ${store}` : null;
  };
}

const COMMANDS = new Map<string, Check>([
  ["update-ca-certificates", (a) => (helpOnly(a) ? null : "update-ca-certificates")],
  ["update-ca-trust", (a) => (helpOnly(a) ? null : "update-ca-trust")],
  ["trust", (a) => (subcommand(a) === "anchor" && !helpOnly(a) ? "trust anchor" : null)],
  [
    "security",
    (a) =>
      subcommand(a) === "add-trusted-cert" && !helpOnly(a) ? "security add-trusted-cert" : null,
  ],
  ["certutil", certutil],
  ["import-certificate", importCertificate("Import-Certificate")],
  ["import-pfxcertificate", importCertificate("Import-PfxCertificate")],
]);

/** Where a file writer puts its output: `tee` any operand, `dd of=`, a copier its last operand or `-t`. */
function destinations(head: string, args: string[]): string[] {
  if (head === "tee") return args;
  if (head === "dd") return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.match(/^(?:-t|--target-directory)(?:=(.*))?$/);
    if (t) out.push(t[1] ?? args[++i] ?? "");
  }
  const operands = args.filter((a) => !a.startsWith("-"));
  return operands.length > 1 ? [...out, operands[operands.length - 1]!] : out;
}

/** `cp ca.crt /usr/local/share/ca-certificates/`, `tee /etc/pki/ca-trust/source/anchors/x.pem`. */
function anchorWrite(head: string, args: string[]): string | null {
  if (!FILE_WRITERS.has(head)) return null;
  const target = destinations(head, args).find(anchorPath);
  return target ? `${head} into ${target}` : null;
}

/** `> /usr/local/share/ca-certificates/x.crt` anywhere in a segment. */
function anchorRedirect(segment: string): string | null {
  const m = segment.match(/(?:^|[^<])>>?\s*['"]?([^\s'"|;&]+)/);
  return m && anchorPath(m[1]!) ? `a redirect into ${m[1]}` : null;
}

function wrapped(args: string[], depth: number): string | null {
  const k = args.findIndex((a) => {
    const head = bin(a);
    return COMMANDS.has(head) || FILE_WRITERS.has(head) || SHELLS.has(head) || WRAPPERS.has(head);
  });
  return k < 0 ? null : wordsFound(args.slice(k), depth + 1);
}

function shellString(args: string[], depth: number): string | null {
  for (const arg of args) {
    const found = /\s/.test(arg) ? commandFound(arg, depth + 1) : null;
    if (found) return found;
  }
  return wrapped(args, depth);
}

function wordsFound(words: string[], depth: number): string | null {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]!) || KEYWORDS.has(words[i]!))) i++;
  const head = bin(words[i] ?? "");
  const args = words.slice(i + 1);
  const check = COMMANDS.get(head);
  if (check) return check(args);
  const write = anchorWrite(head, args);
  if (write || depth >= MAX_DEPTH) return write;
  if (WRAPPERS.has(head)) return wrapped(args, depth);
  return SHELLS.has(head) || head === "eval" ? shellString(args, depth) : null;
}

function segmentFound(segment: string, depth: number): string | null {
  const words = shellWords(segment)
    .map((w) => shellWordValue(w).replace(/^[({]+|[)}]+$/g, ""))
    .filter(Boolean);
  return wordsFound(words, depth) ?? anchorRedirect(segment);
}

function commandFound(command: string, depth: number): string | null {
  for (const segment of shellSegments(command)) {
    const found = segmentFound(segment, depth);
    if (found) return found;
  }
  if (depth >= MAX_DEPTH) return null;
  const inner = [...command.matchAll(/\$\(([^()]{1,2000})\)|`([^`]{1,2000})`/g)].map(
    (m) => m[1] ?? m[2]!,
  );
  for (const body of [...inner, ...windowsShellBodies(command)]) {
    const found = commandFound(body, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The trust-store change in `command`, named, or null. Pure. */
export function caTrustChange(command: string): string | null {
  if (!command || command.length > 100_000) return null;
  return commandFound(command, 0);
}

/** The refusal: what was caught, why it reaches past this project, and who runs it. */
export function caTrustReason(found: string): string {
  return (
    `changes the machine's trusted root certificates (${found}): whoever holds that root's key ` +
    "can intercept TLS for every program on the machine, not only this project. Ask the person " +
    "to run it themselves; an agent does not change system-wide trust (fail-closed)"
  );
}

/** The gate's refusal for `decideBashGate`, read from the command with data-only here-documents removed. */
export function caTrustRefusal(heredocs: { command: string; expansions: string[] }): string | null {
  const found = [heredocs.command, ...heredocs.expansions].map(caTrustChange).find(Boolean);
  return found ? caTrustReason(found) : null;
}
