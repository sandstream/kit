/**
 * `kit security scan-outbound <file|->`: does a PR body, commit message or release note repeat a
 * private agent instruction file? Exit 1 on any span past the minimum, 0 otherwise. Prints the span
 * (redacted, capped), the private file and its line; never a whole private file. See
 * src/outbound-leak.ts for the method and src/outbound-leak-sources.ts for which files count.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import { sanitizeDisplayText } from "../display-text.js";
import {
  DEFAULT_MIN_CHARS,
  GRAM,
  findInstructionLeaks,
  type LeakFinding,
} from "../outbound-leak.js";
import { OUTBOUND_HARNESSES, outboundSources } from "../outbound-leak-sources.js";

const SCAN_OUTBOUND_USAGE = `kit security scan-outbound <file|-> [--min-chars <n>] [--json]`;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** Read at most MAX_INPUT_BYTES from a file or stdin (fd 0); null when larger or unreadable. */
function readInput(target: string): string | null {
  let fd: number;
  try {
    fd = target === "-" ? 0 : openSync(resolve(target), "r");
  } catch {
    return null;
  }
  try {
    if (fd !== 0 && !fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let total = 0;
    for (;;) {
      let count: number;
      try {
        count = readSync(fd, buffer, total, buffer.length - total, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
        if ((e as NodeJS.ErrnoException).code === "EOF") break;
        throw e;
      }
      if (count === 0) break;
      total += count;
      if (total > MAX_INPUT_BYTES) return null;
    }
    return buffer.subarray(0, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== 0) closeSync(fd);
  }
}

function printText(findings: LeakFinding[], privateCount: number, git: boolean): void {
  console.log(`${c.bold}${c.cyan}kit security scan-outbound${c.reset}`);
  console.log(
    `${c.dim}${privateCount} private instruction file(s) (${OUTBOUND_HARNESSES.join(", ")})${git ? "" : "; not a git worktree, so only user-level files count as private"}${c.reset}`,
  );
  for (const f of findings) {
    const lines = f.line === f.endLine ? `${f.line}` : `${f.line}-${f.endLine}`;
    console.log(
      `${c.red}✗${c.reset} ${sanitizeDisplayText(f.file)}:${lines}  ${f.chars} chars (${Math.round(f.share * 100)}% of the file)`,
    );
    console.log(`    "${sanitizeDisplayText(f.span)}"`);
  }
  console.log(
    findings.length
      ? `${c.red}${findings.length} span(s) of private instructions in the outbound text${c.reset}`
      : `${c.green}✓ no private instruction text found${c.reset}`,
  );
}

function minCharsFrom(argv: readonly string[]): number | null {
  const raw = flagValue(argv, "--min-chars");
  if (raw === undefined) return DEFAULT_MIN_CHARS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= GRAM ? n : null;
}

export function cmdSecurityScanOutbound(argv: readonly string[] = process.argv): boolean {
  const target = argv[4];
  const minChars = minCharsFrom(argv);
  if (!target || (target.startsWith("--") && target !== "-") || minChars === null) {
    console.error(`${c.red}Usage: ${SCAN_OUTBOUND_USAGE}${c.reset}`);
    console.error(`${c.dim}--min-chars is an integer of at least ${GRAM}.${c.reset}`);
    return false;
  }
  const text = readInput(target);
  if (text === null) {
    console.error(
      `${c.red}kit security scan-outbound: cannot read ${target} (a file of at most 4 MB, or - for stdin)${c.reset}`,
    );
    return false;
  }
  const sources = outboundSources(process.cwd(), homedir());
  const findings = findInstructionLeaks(text, sources.privates, sources.publicTexts, minChars);
  if (hasFlag(argv, "--json")) {
    console.log(
      JSON.stringify(
        {
          ok: findings.length === 0,
          minChars,
          harnesses: OUTBOUND_HARNESSES,
          git: sources.git,
          privateFiles: sources.privates.map((p) => p.shown),
          publicFiles: sources.publicFiles,
          findings,
        },
        null,
        2,
      ),
    );
  } else printText(findings, sources.privates.length, sources.git);
  return findings.length === 0;
}
