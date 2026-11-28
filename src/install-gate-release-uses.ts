/**
 * The steps after a fetch that a prebuilt-binary install is made of, read from one command's argv:
 * extracting an archive, making a file executable, running it, putting it on PATH, building it,
 * and changing directory into what was extracted. Pure, and nothing is expanded: a destination
 * the shell would expand is "dynamic" (the chain refuses it when a fetched file is moved there).
 */
import { DYNAMIC, headName, psParam, psPositional } from "./install-gate-release-steps.js";

export interface Extract {
  /** Archive operands, or "stdin" when the archive arrives on standard input. */
  archives: string[] | "stdin";
  /** Where it extracts to, when named. */
  dest?: string;
}

const TAR_VALUED = new Set([
  "-f",
  "--file",
  "-C",
  "--directory",
  "-T",
  "--files-from",
  "-X",
  "--exclude-from",
]);

/** True when tar's options ask for extraction: `x` in the old-style first word or a short cluster, or `--extract`. */
function tarExtracts(argv: string[]): boolean {
  const first = argv[1] ?? "";
  const oldStyle = /^[A-Za-z]+$/.test(first) ? first : "";
  const flags = argv.filter((t, i) => i > 0 && /^-[A-Za-z]+$/.test(t)).join("");
  return /x/.test(oldStyle + flags) || argv.includes("--extract") || argv.includes("--get");
}

/** The archive a tar option names, or undefined. `next` is the following token. */
function tarFile(t: string, next: string | undefined, first: boolean): string | undefined {
  if (t.startsWith("--file=")) return t.slice(7);
  if (t.startsWith("--")) return t === "--file" ? next : undefined;
  if (first && /^[A-Za-z]+$/.test(t)) return /f/.test(t) ? next : undefined;
  if (/^-[A-Za-z]*f$/.test(t)) return next;
  const glued = /^-[A-Za-z]*f(.+)$/.exec(t);
  return glued ? glued[1] : undefined;
}

function tarExtract(argv: string[]): Extract | null {
  if (!tarExtracts(argv)) return null;
  let file: string | undefined;
  let dest: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "-C" || t === "--directory") dest = argv[i + 1];
    else if (t.startsWith("--directory=")) dest = t.slice(12);
    else file = tarFile(t, argv[i + 1], i === 1) ?? file;
    if (TAR_VALUED.has(t)) i++;
  }
  return { archives: file === undefined || file === "-" ? "stdin" : [file], dest };
}

function unzipExtract(argv: string[]): Extract {
  let dest: string | undefined;
  const operands: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "-d") dest = argv[++i];
    else if (t === "-P" || t === "-x") i++;
    else if (!t.startsWith("-")) operands.push(t);
  }
  return { archives: operands.slice(0, 1), dest };
}

function sevenZipExtract(argv: string[]): Extract | null {
  if (argv[1] !== "x" && argv[1] !== "e") return null;
  const out = argv.find((t) => t.startsWith("-o"));
  return {
    archives: argv
      .slice(2)
      .filter((t) => !t.startsWith("-"))
      .slice(0, 1),
    dest: out?.slice(2),
  };
}

const DECOMPRESSORS = new Set(["gunzip", "unxz", "bunzip2", "unzstd", "uncompress", "unlzma"]);
const DECOMPRESS_FLAG = new Set(["gzip", "xz", "bzip2", "zstd", "lzma"]);

function decompressOf(head: string, argv: string[]): Extract | null {
  const flagged = argv.some((t) => /^-[A-Za-z]*d/.test(t) || t === "--decompress");
  if (!DECOMPRESSORS.has(head) && !(DECOMPRESS_FLAG.has(head) && flagged)) return null;
  const files = argv.slice(1).filter((t) => !t.startsWith("-"));
  return { archives: files.length ? files : "stdin" };
}

function expandArchive(argv: string[]): Extract {
  const path =
    psParam(argv, "path", 1) ??
    psParam(argv, "literalpath", 1) ??
    psPositional(argv, ["destinationpath", "path", "literalpath"]);
  return { archives: path ? [path] : [], dest: psParam(argv, "destinationpath", 1) };
}

const EXTRACTORS: Record<string, (argv: string[]) => Extract | null> = {
  tar: tarExtract,
  bsdtar: tarExtract,
  gtar: tarExtract,
  unzip: unzipExtract,
  "7z": sevenZipExtract,
  "7za": sevenZipExtract,
  "7zz": sevenZipExtract,
  "expand-archive": expandArchive,
};

/** What one command extracts, or null when it extracts nothing. */
export function extractOf(argv: string[]): Extract | null {
  const head = headName(argv[0] ?? "");
  const extractor = Object.hasOwn(EXTRACTORS, head) ? EXTRACTORS[head] : undefined;
  return extractor ? extractor(argv) : decompressOf(head, argv);
}

/** True for a chmod mode that sets an execute bit: `+x`, `u+x`, `755`, `a=rwx`. */
function executableMode(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return [...mode.slice(-3)].some((d) => Number(d) % 2 === 1);
  return (
    /^[ugoa]*[+=][rwxXst]*x/.test(mode) || mode.split(",").some((m) => /[+=][rwXst]*x/.test(m))
  );
}

/** Files a command makes executable: `chmod +x f`, PowerShell `Unblock-File f` (drops the downloaded mark). */
export function madeExecutable(argv: string[]): string[] {
  const head = headName(argv[0] ?? "");
  if (head === "unblock-file") {
    const p =
      psParam(argv, "path", 1) ??
      psParam(argv, "literalpath", 1) ??
      psPositional(argv, ["path", "literalpath"]);
    return p ? [p] : [];
  }
  if (head !== "chmod") return [];
  const operands = argv.slice(1).filter((t) => !/^-[A-Za-z]+$/.test(t) && !t.startsWith("--"));
  const [mode, ...files] = operands;
  return mode !== undefined && executableMode(mode) ? files : [];
}

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "pwsh",
  "powershell",
  "source",
  ".",
  "msiexec",
]);
const INLINE = /^-(?:c|e|command|encodedcommand|ec|m)$/i;

export const pathLike = (t: string): boolean => /[\\/]/.test(t) || /^\.{1,2}$/.test(t);

/** An interpreter's script operand, or null for inline code (`-c`, `-Command`, `-e`, `-m`). */
function scriptOperand(args: string[]): string | null {
  for (const t of args) {
    if (INLINE.test(t)) return null;
    if (!t.startsWith("-") && !/^\/[iap]$/i.test(t)) return t;
  }
  return null;
}

const STARTERS = new Set(["start-process", "saps", "start"]);

/** The file a command runs: a path-like command head, an interpreter's script, `Start-Process f`, `& f`. */
export function runOperand(argv: string[]): string | null {
  const first = argv[0] ?? "";
  const head = headName(first);
  if (STARTERS.has(head)) {
    const named = psParam(argv, "filepath", 1);
    return named ?? psPositional(argv, ["filepath", "argumentlist", "workingdirectory"]) ?? null;
  }
  if (first === "&") return argv[1] ?? null;
  if (INTERPRETERS.has(head)) return scriptOperand(argv.slice(1));
  return pathLike(first) ? first : null;
}

const BUILDERS = new Set(["make", "gmake", "cmake", "ninja", "meson", "scons"]);

/** True for a build tool, which runs build files from the directory it is in (or `-C dir`). */
export const isBuild = (argv: string[]): boolean => BUILDERS.has(headName(argv[0] ?? ""));

const PLACERS = new Set(["mv", "cp", "install", "ln", "rsync"]);
const PLACE_VALUED = new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]);

export interface Place {
  sources: string[];
  dest: string;
  /** `install(1)` sets the mode it is given, so it counts wherever it puts the file. */
  install: boolean;
}

function psPlace(argv: string[]): Place | null {
  const dest = psParam(argv, "destination", 1);
  const source = psParam(argv, "path", 1) ?? psParam(argv, "literalpath", 1);
  const positional = argv
    .slice(1)
    .filter((t, i, a) => !t.startsWith("-") && !/^-/.test(a[i - 1] ?? ""));
  const sources = source ? [source] : positional.slice(0, 1);
  const to = dest ?? positional[source ? 0 : 1];
  return to === undefined ? null : { sources, dest: to, install: false };
}

const PS_PLACERS = new Set(["move-item", "copy-item", "mi", "cpi", "move", "copy"]);

/** Where a command copies, moves, links or installs files to, or null. */
export function placeOf(argv: string[]): Place | null {
  const head = headName(argv[0] ?? "");
  if (PS_PLACERS.has(head)) return psPlace(argv);
  if (!PLACERS.has(head)) return null;
  let target: string | undefined;
  const operands: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "-t" || t === "--target-directory") target = argv[++i];
    else if (t.startsWith("--target-directory=")) target = t.slice(19);
    else if (PLACE_VALUED.has(t)) i++;
    else if (!t.startsWith("-")) operands.push(t);
  }
  const dest = target ?? operands.pop();
  return dest === undefined ? null : { sources: operands, dest, install: head === "install" };
}

const HOME =
  /^(?:~|\$HOME\b|\$\{HOME\}|\$env:(?:USERPROFILE|HOME)\b|%USERPROFILE%|\$\{env:USERPROFILE\})/i;
const WINDOWS_PATH_ROOT =
  /^(?:\$env:(?:LOCALAPPDATA|APPDATA|ProgramFiles|ProgramW6432|SystemRoot|windir)\b|\$\{env:(?:LOCALAPPDATA|APPDATA|ProgramFiles(?:\(x86\))?)\}|%(?:LOCALAPPDATA|APPDATA|ProgramFiles|ProgramFiles\(x86\)|SystemRoot|windir)%|[A-Za-z]:\/(?:Program Files|Windows|Users|ProgramData)\b)/i;
const POSIX_HOMES = /^\/(?:home|Users|root)(?:\/|$)/;

/** "path" when a destination is on or under a PATH-style location, "dynamic" when the shell decides, else "local". */
export function destinationKind(dest: string): "path" | "dynamic" | "local" {
  const d = dest.replace(/\\/g, "/");
  if (HOME.test(d) || WINDOWS_PATH_ROOT.test(d) || POSIX_HOMES.test(d)) return "path";
  if (DYNAMIC.test(d)) return "dynamic";
  if (d.startsWith("/") && d.split("/").some((s) => s === "bin" || s === "sbin")) return "path";
  return "local";
}

/** The directory a `cd`/`pushd`/`Set-Location` moves into, or null. */
export function cdTarget(argv: string[]): string | null {
  const head = headName(argv[0] ?? "");
  if (
    head !== "cd" &&
    head !== "pushd" &&
    head !== "set-location" &&
    head !== "sl" &&
    head !== "chdir"
  )
    return null;
  return argv.slice(1).find((t) => !t.startsWith("-")) ?? "~";
}

/** `make -C dir` / `cmake -S dir` / `ninja -C dir`: the build's directory, when named. */
export function buildDirectory(argv: string[]): string | null {
  const at = argv.findIndex((t) => t === "-C" || t === "-S" || t === "--directory");
  return at > 0 ? (argv[at + 1] ?? null) : null;
}

const INSTALL_ROOTS =
  /^(?:\/usr(?:\/local)?|\/opt)(?:\/|$)|^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE)\/(?:\.local|bin)(?:\/|$)|^(?:\$env:LOCALAPPDATA|%LOCALAPPDATA%|\$\{env:LOCALAPPDATA\})\/(?:Programs|Microsoft\/WindowsApps)(?:\/|$)/i;

const WINDOWS_INSTALL_ROOTS =
  /^(?:[A-Za-z]:\/(?:Program Files|Windows)\b|\$env:(?:ProgramFiles|ProgramW6432|SystemRoot|windir)\b|\$\{env:ProgramFiles(?:\(x86\))?\}|%(?:ProgramFiles|ProgramFiles\(x86\)|SystemRoot|windir)%)/i;

/** True when an archive extracted to `dest` lands in an install location (`-C /usr/local`, `-DestinationPath 'C:\\Program Files\\x'`). */
export function installLocation(dest: string): boolean {
  const d = dest.replace(/\\/g, "/");
  if (INSTALL_ROOTS.test(d) || WINDOWS_INSTALL_ROOTS.test(d)) return true;
  return d.startsWith("/") && d.split("/").some((s) => s === "bin" || s === "sbin");
}
