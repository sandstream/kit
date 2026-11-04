/**
 * The `kit triage check-skills` pre-commit gate: every agent skill with staged changes needs a
 * fresh deep triage of exactly its staged content. Split out of src/commands/triage.ts.
 */
import { SKIPPED_COMMITS_LOG } from "./hooks.js";
import { readStagedSkill, skillDigest, skillName } from "./skill-triage-binding.js";
import { TRIAGE_LOG_FILE, TRIAGE_MAX_AGE_DAYS, type TriageLogEntry } from "./triage-receipt.js";
import { c } from "./utils/colors.js";

/** A staged path inside a skill directory: `.claude/skills/<name>/…`. Group 1 = skill name. */
const SKILL_PATH_RE = /^\.claude\/skills\/([^/]+)\/.+/;

/**
 * Parse `git diff --cached --name-only` output into the unique set of agent-skill names touched.
 * Only files *inside* a skill dir count; the bare `.claude/skills/<name>` dir entry never appears in
 * a name-only diff, so a skill is "staged" exactly when one of its files is.
 */
export function parseStagedSkillNames(files: string[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    const m = SKILL_PATH_RE.exec(f.trim());
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Most-recent DEEP skill-triage timestamp (ms) per skill name, from the triage log. Only
 * `type:"skill"` entries with `deep === true` count — a shallow skill triage never satisfies the
 * deep gate. With `digests`, an entry counts only when its `contentDigest` equals the digest given
 * for its skill name: a triage of other content under the same name (an earlier version, or an
 * unrelated directory) does not count, and neither does an entry written before kit recorded
 * digests. A forged/unparseable timestamp is dropped (it can't count as fresh). Pure.
 */
export function latestDeepSkillTriage(
  entries: TriageLogEntry[],
  digests?: ReadonlyMap<string, string>,
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== "skill" || e.deep !== true) continue;
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) continue; // fail-closed: garbage ts is never "fresh"
    const name = skillName(e.target);
    if (digests && (!e.contentDigest || e.contentDigest !== digests.get(name))) continue;
    const prev = latest.get(name);
    if (prev === undefined || ts > prev) latest.set(name, ts);
  }
  return latest;
}

/**
 * Pure gate core: which staged skills lack a fresh (≤ `maxAgeDays`) deep triage of exactly the
 * staged content (`stagedDigests`, name → digest). A missing entry, a shallow-only entry, an entry
 * for other content, or a stale/forged timestamp all count as "missing" (fail-closed).
 */
export function missingDeepSkillTriage(
  stagedSkillNames: string[],
  entries: TriageLogEntry[],
  nowMs: number,
  stagedDigests: ReadonlyMap<string, string>,
  maxAgeDays = TRIAGE_MAX_AGE_DAYS,
): string[] {
  const latest = latestDeepSkillTriage(entries, stagedDigests);
  const cutoff = nowMs - maxAgeDays * 24 * 3600 * 1000;
  const missing: string[] = [];
  for (const name of stagedSkillNames) {
    const ts = latest.get(name);
    if (ts === undefined || ts < cutoff) missing.push(name);
  }
  return missing;
}

/**
 * `kit triage check-skills` — pre-commit gate (increment 2b). Any agent skill with staged changes
 * under `.claude/skills/<name>/…` must have a `kit triage skill <name> --deep` entry in the triage
 * log within the last `TRIAGE_MAX_AGE_DAYS` days. A shallow triage does NOT satisfy the gate: agent
 * skills ship executable scripts, so the deep STATIC pass (SkillSpector Stage 1 — no LLM, no egress)
 * is required before they enter history. Fail-CLOSED: no log, a stale entry, or a shallow-only entry
 * all block the commit. Exits non-zero on any missing skill so the pre-commit hook fails.
 */
export async function cmdTriageCheckSkills(): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  let staged: string[];
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    staged = out.split("\n");
  } catch {
    return true; // not a git repo / nothing staged — nothing to gate
  }

  const skillNames = parseStagedSkillNames(staged);
  if (skillNames.length === 0) return true;

  const entries: TriageLogEntry[] = [];
  try {
    const text = await readFile(resolve(process.cwd(), TRIAGE_LOG_FILE), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as TriageLogEntry);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no triage log yet — every staged skill is missing */
  }

  const stagedDigests = new Map<string, string>();
  for (const name of skillNames) {
    try {
      stagedDigests.set(name, skillDigest(readStagedSkill(name, process.cwd())));
    } catch {
      /* unreadable index: no digest, so the skill reads as missing (fail-closed) */
    }
  }
  const missing = missingDeepSkillTriage(skillNames, entries, Date.now(), stagedDigests);
  if (missing.length === 0) return true;

  console.error(`${c.red}✗ Deep triage missing for ${missing.length} staged skill(s):${c.reset}`);
  for (const name of missing) {
    console.error(`  - ${name}  (run: kit triage skill ${name} --deep)`);
  }
  console.error("");
  console.error(
    `${c.dim}Agent skills ship executable scripts — the deep static scan (no LLM, no egress) is`,
  );
  console.error(
    `required before they enter history, and it must be of the content that is staged: run the`,
  );
  console.error(`command(s) above after staging, with SkillSpector installed, then commit.`);
  console.error(`Bypass with --no-verify is recorded to ${SKIPPED_COMMITS_LOG}.${c.reset}`);
  return false;
}
