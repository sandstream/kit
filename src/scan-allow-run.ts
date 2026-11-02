import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { c } from "./utils/colors.js";
import { exec } from "./utils/exec.js";
import { applyAllow, parseScanAllow, type AllowEntry } from "./scan-allow.js";
import type { StagedHit } from "./scan-staged.js";

const KIT_FILE = ".kit.toml";

async function gitText(cwd: string, spec: string): Promise<string | undefined> {
  try {
    return (await exec("git", ["show", spec], { cwd, timeout: 5_000, maxBuffer: 5 * 1024 * 1024 }))
      .stdout;
  } catch {
    return undefined;
  }
}

/**
 * The text of `.kit.toml` that the commit will carry: the staged version if it is staged, else the
 * one in HEAD. Never the working copy. An exception that exists only on one machine is not in the
 * history, so no reviewer sees it, and the point of the list is that review does.
 */
async function committedConfig(cwd: string, staged: string[]): Promise<string | undefined> {
  return gitText(cwd, staged.includes(KIT_FILE) ? `:${KIT_FILE}` : `HEAD:${KIT_FILE}`);
}

/** The raw `[[scan.allow]]` list in that text. Read on its own, so an unrelated config error does not hide it. */
function allowTables(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return (parse(text) as { scan?: { allow?: unknown } }).scan?.allow;
  } catch {
    return undefined; // unreadable config: no exceptions apply, so findings still block
  }
}

function workingCopyDiffers(cwd: string, committed: string | undefined): boolean {
  const path = join(cwd, KIT_FILE);
  if (!existsSync(path)) return false;
  const working = readFileSync(path, "utf-8");
  return working !== committed && working.includes("[[scan.allow]]");
}

async function stagedPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
      { cwd, timeout: 5_000 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

const label = (e: AllowEntry): string =>
  `${e.path} (${e.match}${e.preview ? `, ${e.preview}` : ""})`;

function report(
  used: ReturnType<typeof applyAllow>["used"],
  stale: ReturnType<typeof applyAllow>["stale"],
) {
  for (const u of used) {
    console.error(
      `${c.dim}note: ${u.count} finding(s) in ${u.file} allowed by [[scan.allow]] ${label(u.entry)}: ${u.entry.reason}${c.reset}`,
    );
  }
  for (const s of stale) {
    console.error(
      `${c.yellow}warning: [[scan.allow]] entry ${label(s.entry)} is stale, ${s.why}. Remove it if the exception is no longer needed.${c.reset}`,
    );
  }
}

/**
 * Apply the reviewed exceptions in `.kit.toml` to the staged findings. `ok: false` means the
 * allowlist itself is broken, and the commit must be blocked: a broken exception list is never
 * read as "no exceptions" silently, and never as "allow everything".
 */
export async function applyScanAllowlist(
  hits: StagedHit[],
  cwd: string = process.cwd(),
): Promise<{ hits: StagedHit[]; ok: boolean }> {
  const staged = await stagedPaths(cwd);
  const committed = await committedConfig(cwd, staged);
  if (workingCopyDiffers(cwd, committed)) {
    console.error(
      `${c.yellow}note: [[scan.allow]] in the working copy of ${KIT_FILE} is not applied until it is staged or committed, so review can see it.${c.reset}`,
    );
  }
  const { entries, problems } = parseScanAllow(allowTables(committed));
  for (const p of problems) console.error(`${c.red}✗ ${p.message}${c.reset}`);
  if (problems.length > 0) return { hits, ok: false };
  if (entries.length === 0) return { hits, ok: true };
  const result = applyAllow(hits, entries, staged, (p) => existsSync(join(cwd, p)));
  report(result.used, result.stale);
  if (result.used.length > 0 && staged.includes(KIT_FILE)) {
    console.error(
      `${c.yellow}warning: ${KIT_FILE} is part of this commit and an allow entry silenced a finding. Check that the entry is intended.${c.reset}`,
    );
  }
  return { hits: result.hits, ok: true };
}
