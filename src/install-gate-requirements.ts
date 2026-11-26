/**
 * `pip install -r requirements.txt` names no package on the command line either: the gate sees
 * zero targets and allowed it, while a bare `npm install` of an untracked package.json was blocked
 * (`install-gate-bare.ts`, kit#844). This is the pip side of that rule. A requirements file that
 * git does not track needs a fresh `kit triage pip` receipt (`.kit-triage.jsonl`, the same file
 * and window) for every requirement it names. A tracked file is left to `kit triage check-deps`,
 * as a tracked package.json is. `pip-sync <file>...` and `uv pip sync <file>...` install the files
 * they name and are held to the same rule.
 *
 * The file is read, never run. Anything in it that is not a plain registry requirement (a nested
 * `-r`, an index or find-links option, an editable, a URL, a direct `name @ url` reference)
 * is refused, because a receipt for a name does not cover it. Transitive dependencies are not
 * triaged here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  freshReceipts,
  installDirectory,
  literalPath,
  type BareSegment,
  type BareVerdict,
} from "./install-gate-bare.js";
import { TRIAGE_MAX_AGE_DAYS } from "./triage-receipt.js";

/** The value of every `-r <file>`, `-r<file>`, `--requirement <file>` and `--requirement=<file>`. */
export function requirementFileValues(tokens: string[]): (string | undefined)[] {
  const values: (string | undefined)[] = [];
  tokens.forEach((token, i) => {
    if (token === "-r" || token === "--requirement") values.push(tokens[i + 1]);
    else if (token.startsWith("--requirement=")) values.push(token.slice("--requirement=".length));
    else if (/^-r[^-]/.test(token)) values.push(token.slice(2));
  });
  return values;
}

// Options of `pip-sync` and `uv pip sync` that take a value. Any other option is read as taking
// none, so a misread can only add a file to check, never hide one.
const SYNC_VALUE_FLAGS = new Set([
  "-c",
  "--constraint",
  "-b",
  "--build-constraint",
  "-p",
  "--python",
  "--python-executable",
  "--python-version",
  "--python-platform",
  "--target",
  "--prefix",
  "--index-strategy",
  "--keyring-provider",
  "-C",
  "--config-setting",
  "--reinstall-package",
  "--refresh-package",
  "--no-binary",
  "--only-binary",
  "--no-build-package",
  "--exclude-newer",
  "--link-mode",
  "--cache-dir",
  "--allow-insecure-host",
  "--trusted-host",
  "--cert",
  "--client-cert",
]);

/**
 * The files a `pip-sync` or `uv pip sync` installs: its operands, read from `args` (the tokens after
 * the verb). `fallback` is the file the command reads when it is given none (pip-sync's
 * `requirements.txt`). A constraints file is an option value: it installs nothing.
 */
export function syncFileValues(args: string[], fallback?: string): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (SYNC_VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith("-") || arg === "-") files.push(arg);
  }
  return files.length === 0 && fallback ? [fallback] : files;
}

/** `pip-sync`, `python -m piptools sync` and `uv pip sync` → the index after the verb, else -1. */
function syncArgStart(tokens: string[]): number {
  const [a, b, c, d] = tokens;
  if (a === "pip-sync") return 1;
  if ((a === "python" || a === "python3") && b === "-m" && c === "piptools" && d === "sync")
    return 4;
  if (a !== "uv") return -1;
  const at = tokens.findIndex((token, i) => token === "pip" && tokens[i + 1] === "sync");
  return at > 0 ? at + 2 : -1;
}

// What a sync reads that a name receipt does not cover: a find-links source, pip arguments passed
// through, a config file, another working directory, or stdin.
const SYNC_STEERING =
  /^(?:-f.*|--find-links(?:=.*)?|--pip-args(?:=.*)?|--config(?:-file)?(?:=.*)?|--directory(?:=.*)?|-)$/;

/**
 * A `pip-sync`, `python -m piptools sync` or `uv pip sync` as a segment whose `files` are its
 * operands; the option the gate cannot see past, as a string; or undefined when it is no sync.
 */
export function syncSegment(tokens: string[]): BareSegment | string | undefined {
  const start = syncArgStart(tokens);
  if (start < 0) return undefined;
  const steer = tokens.slice(1).find((token) => SYNC_STEERING.test(token));
  if (steer) return steer;
  const fallback = tokens[0] === "uv" ? undefined : "requirements.txt";
  return { manager: tokens[0], tokens, files: syncFileValues(tokens.slice(start), fallback) };
}

/** PEP 503 normalised project name, so `Example_Pkg` and `example-pkg` are one receipt. */
export function pipNormalise(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const pipReceiptName = (target: string): string =>
  pipNormalise(target.split(/[\s<>=!~@[;]/)[0] ?? target);

// Options that only shape how pip picks among registry releases; anything else is refused.
const HARMLESS_OPTION =
  /^(--pre|--prefer-binary|--require-hashes|--only-binary(?:[= ].*)?|--no-binary(?:[= ].*)?|--use-feature(?:[= ].*)?|-c\s.*|--constraint(?:[= ].*)?)$/;
const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/;
const LOCAL = /^(?:\.{1,2}[\\/]|[\\/]|file:)/;

type Requirement = { name: string } | { refused: string } | undefined;

function classifyLine(line: string): Requirement {
  if (line.startsWith("-")) {
    return HARMLESS_OPTION.test(line) ? undefined : { refused: `option ${line.split(/\s/)[0]}` };
  }
  if (LOCAL.test(line)) return undefined; // a local path is already on disk, as npm's file:
  const match = NAME.exec(line);
  // A URL, a VCS spec or anything else that is not a name.
  if (!match || /^[a-z+]+:/i.test(line)) return { refused: `${line} (no registry triage)` };
  const rest = (match[2] ?? "").replace(/\s--hash[= ]\S+/g, "").trim();
  if (rest.startsWith("@"))
    return { refused: `${match[1]} (a direct reference has no registry triage)` };
  return { name: pipNormalise(match[1]!) };
}

/** Every requirement line of `text`: continuations joined, comments and blank lines dropped. */
function requirementLines(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
}

function isTracked(file: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", basename(file)], {
      cwd: dirname(file),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function refusal(dir: string, detail: string): BareVerdict {
  return { block: true, reason: `bare install in ${dir}: ${detail} (fail-closed)` };
}

/** The untracked requirements files the command installs, or a refusal when one cannot be resolved. */
function untrackedFiles(dir: string, segments: BareSegment[]): string[] | BareVerdict {
  const files: string[] = [];
  for (const value of segments.flatMap((s) => s.files ?? requirementFileValues(s.tokens))) {
    const file = value === undefined ? undefined : literalPath(value, dir);
    if (!file)
      return refusal(
        dir,
        `cannot tell which requirements file is installed (${value ?? "-r without a value"})`,
      );
    if (existsSync(file) && !isTracked(file)) files.push(file);
  }
  return files;
}

/** The requirement names in `files`, or a refusal naming what cannot be triaged. */
function requirementNames(dir: string, files: string[]): string[] | BareVerdict {
  const names: string[] = [];
  const refused: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return refusal(dir, `${basename(file)} cannot be read`);
    }
    for (const entry of requirementLines(text).map(classifyLine)) {
      if (entry && "refused" in entry) refused.push(`${basename(file)}: ${entry.refused}`);
      else if (entry) names.push(entry.name);
    }
  }
  return refused.length > 0 ? refusal(dir, `cannot triage ${refused.join(", ")}`) : names;
}

/** Decide a pip install from requirements files. Reads the files, the receipts and `git ls-files`. */
export function checkRequirementsInstall(
  command: string,
  cwd: string,
  segments: BareSegment[],
): BareVerdict {
  const where = installDirectory(command, cwd, segments);
  if ("unresolved" in where) {
    return refusal(cwd, `cannot tell which directory is installed (${where.unresolved})`);
  }
  const { dir } = where;
  const files = untrackedFiles(dir, segments);
  if (!Array.isArray(files)) return files;
  if (files.length === 0) {
    return {
      block: false,
      reason: "no untracked requirements file; `kit triage check-deps` gates a tracked one",
    };
  }
  const names = requirementNames(dir, files);
  if (!Array.isArray(names)) return names;
  const have = freshReceipts(dir, "pip", pipReceiptName);
  const missing = [...new Set(names.filter((name) => !have.has(name)))];
  if (missing.length === 0) return { block: false, reason: "requirements triaged" };
  return {
    block: true,
    reason:
      `bare install in ${dir}: no fresh triage receipt (${TRIAGE_MAX_AGE_DAYS} days) for ` +
      `${missing.join(", ")}. Run \`cd ${dir} && kit triage pip ${missing.join(" ")}\` first`,
  };
}
