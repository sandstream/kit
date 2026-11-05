// `kit triage pkg <file.pkg>`: check a macOS installer package before it is opened.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import {
  defaultPkgDeps,
  isTeamId,
  triagePkg,
  type PkgOptions,
  type PkgReport,
  type PkgStatus,
} from "../pkg-triage.js";

const VALUE_FLAGS = ["--checksum", "--team-id"];
const MAX_SHASUMS = 2_000_000;

const NOTE =
  "Checks the file against what the publisher says it is. It does not install or open the package, and it cannot say the software is safe. It needs macOS for the signature and notarization checks.";

const MARK: Record<PkgStatus, string> = {
  pass: `${c.green}✓${c.reset}`,
  fail: `${c.red}✗${c.reset}`,
  unverified: `${c.yellow}?${c.reset}`,
};

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.includes(a)) i++;
    else if (!a.startsWith("--")) return a;
  }
  return undefined;
}

function render(r: PkgReport): void {
  console.log(`${c.bold}kit triage pkg${c.reset} — ${r.file}`);
  console.log(`  sha256 ${r.sha256}${r.publisher ? `  (expected publisher: ${r.publisher})` : ""}`);
  for (const k of r.checks) console.log(`  ${MARK[k.status]} ${k.name}: ${k.detail}`);
  const verdict = r.passed ? `${c.green}passed${c.reset}` : `${c.red}not passed${c.reset}`;
  console.log(`\n  ${verdict}. ${c.dim}${NOTE}${c.reset}`);
}

/** A checksum list through one descriptor (checked with fstat on it), or null when unusable. */
function readChecksumList(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.size <= MAX_SHASUMS ? readFileSync(fd, "utf8") : null;
  } finally {
    closeSync(fd);
  }
}

function options(args: string[]): PkgOptions | string {
  const team = flagValue(args, "--team-id");
  if (team !== undefined && !isTeamId(team)) return "--team-id needs ten capitals or digits";
  const given = flagValue(args, "--checksum");
  if (given === undefined) return { teamId: team };
  if (/^[0-9a-fA-F]{64}$/.test(given)) return { teamId: team, sha256: given };
  const text = readChecksumList(resolve(given));
  if (text === null) {
    return `--checksum needs 64 hex digits or a readable checksum list, not ${JSON.stringify(given)}`;
  }
  return { teamId: team, shasumsText: text };
}

/** Exit status: true only when every check passed. */
export async function cmdTriagePkg(args: string[]): Promise<boolean> {
  const given = positional(args);
  if (!given) {
    console.error("usage: kit triage pkg <file.pkg> [--team-id ID] [--checksum HEX|FILE] [--json]");
    return false;
  }
  const file = resolve(given);
  const opts = options(args);
  if (typeof opts === "string") {
    console.error(`kit triage pkg: ${opts}`);
    return false;
  }
  let report: PkgReport;
  try {
    report = await triagePkg(file, opts, defaultPkgDeps);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    console.error(`kit triage pkg: cannot read ${JSON.stringify(file)} (${code})`);
    return false;
  }
  if (hasFlag(args, "--json")) console.log(JSON.stringify({ ...report, note: NOTE }, null, 2));
  else render(report);
  return report.passed;
}
