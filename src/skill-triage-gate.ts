/**
 * The `kit triage check-skills` pre-commit gate: every agent skill with staged changes needs a
 * fresh deep triage of exactly its staged content. Split out of src/commands/triage.ts.
 */
import { SKIPPED_COMMITS_LOG } from "./hooks.js";
import { readStagedSkill, skillDigest, skillName } from "./skill-triage-binding.js";
import {
  skillScanEvidenceSchema,
  TRIAGE_LOG_FILE,
  TRIAGE_MAX_AGE_DAYS,
  type TriageLogEntry,
} from "./triage-receipt.js";
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
    const m = SKILL_PATH_RE.exec(f);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

const receiptLabels = {
  current: "current",
  stale: "expired",
  unsupported: "unsupported receipt format",
  malformed: "malformed receipt",
  changed: "content differs from the staged skill",
} as const;

type ReceiptStatus = keyof typeof receiptLabels;

function receiptStatus(
  entry: TriageLogEntry,
  digest: string | undefined,
  nowMs: number,
  cutoff: number,
): ReceiptStatus {
  const scan = entry.skillScan;
  if (scan === undefined || (typeof scan?.version === "number" && scan.version !== 1))
    return "unsupported";
  const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > nowMs) return "malformed";
  if (!skillScanEvidenceSchema.safeParse(scan).success) return "malformed";
  if (!digest || entry.contentDigest !== digest) return "changed";
  return timestamp < cutoff ? "stale" : "current";
}

/** Find the outcomes for each staged skill. A current receipt for its content satisfies the gate. */
function inspectReceipts(
  names: string[],
  entries: TriageLogEntry[],
  nowMs: number,
  digests: ReadonlyMap<string, string>,
  maxAgeDays: number,
): Map<string, Set<ReceiptStatus>> {
  const statuses = new Map(names.map((name) => [name, new Set<ReceiptStatus>()]));
  const cutoff = nowMs - maxAgeDays * 24 * 3600 * 1000;
  for (const entry of entries) {
    if (entry?.type !== "skill" || entry.deep !== true || typeof entry.target !== "string")
      continue;
    const name = skillName(entry.target);
    const observed = statuses.get(name);
    if (observed) observed.add(receiptStatus(entry, digests.get(name), nowMs, cutoff));
  }
  return statuses;
}

/** Give the operator a reason for each refusal. */
export function deepSkillTriageFailures(
  names: string[],
  entries: TriageLogEntry[],
  nowMs: number,
  digests: ReadonlyMap<string, string>,
  maxAgeDays = TRIAGE_MAX_AGE_DAYS,
): Map<string, string> {
  const failures = new Map<string, string>();
  for (const [name, statuses] of inspectReceipts(names, entries, nowMs, digests, maxAgeDays)) {
    if (!digests.has(name)) failures.set(name, "cannot read staged content");
    else if (statuses.has("current")) continue;
    else if (!statuses.size) failures.set(name, "missing receipt");
    else failures.set(name, Array.from(statuses, (status) => receiptLabels[status]).join(", "));
  }
  return failures;
}

/**
 * `kit triage check-skills` — pre-commit gate (increment 2b). Any agent skill with staged changes
 * under `.claude/skills/<name>/…` must have a `kit triage skill <name> --deep` entry in the triage
 * log within the last `TRIAGE_MAX_AGE_DAYS` days. A shallow triage does NOT satisfy the gate: agent
 * skills ship executable scripts, so the deep static pass (SkillSpector Stage 1)
 * is required before they enter history. Fail-CLOSED: no log, a stale entry, or a shallow-only entry
 * all block the commit. Exits non-zero on any missing skill so the pre-commit hook fails.
 */
export async function cmdTriageCheckSkills(): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  let staged: string[];
  try {
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    staged = out.split("\0");
  } catch {
    console.error("Cannot read the Git index. Deep triage is unverified.");
    return false;
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
  const failures = deepSkillTriageFailures(skillNames, entries, Date.now(), stagedDigests);
  if (failures.size === 0) return true;

  console.error(`${c.red}✗ Deep triage required for ${failures.size} staged skill(s):${c.reset}`);
  for (const [name, reason] of failures) {
    console.error(`  - ${name}: ${reason} (run: kit triage skill ${name} --deep)`);
  }
  console.error("");
  console.error(
    `${c.dim}Run the commands above with a version of SkillSpector that reports coverage.`,
  );
  console.error(`Run each scan on the staged content before you commit.`);
  console.error(`Bypass with --no-verify is recorded to ${SKIPPED_COMMITS_LOG}.${c.reset}`);
  return false;
}
