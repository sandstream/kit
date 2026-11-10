/**
 * `kit skill test <path>` — deterministic module-discipline linter for a `SKILL.md`.
 *
 * A thin executor over the pure core in `../skill/test.ts`: it reads the target
 * `SKILL.md`, discovers sibling skills (for trigger-collision detection) and a committed
 * snapshot (for regression), runs the four deterministic checks, and prints a human or
 * `--json` report. `--update-snapshot` pins the current module surface; `--gate` turns any
 * failure into a non-zero exit for CI.
 *
 * This is the module-discipline sibling of `kit triage skill` (which answers "safe to
 * install?" via the SkillSpector delegate). It answers "engineered like a module?" — a
 * different question, same zero-LLM, fail-closed discipline. It NEVER runs the skill, and
 * it NEVER grades output quality (that is an LLM eval harness, disclaimed in the output).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import {
  parseSkillManifest,
  testSkill,
  snapshotOf,
  triggerKey,
  type SiblingSkill,
  type SkillSnapshot,
  type CheckResult,
  type DisclaimedItem,
} from "../skill/test.js";
import type { DatabaseSync } from "node:sqlite";
import {
  auditRuntime,
  type RuntimeCheckResult,
  type RuntimeEvidence,
  type RuntimeEvidenceSummary,
  type ObservedAction,
} from "../skill/adherence.js";
import { readRunEvidence } from "../skill/attribute.js";

/** Snapshot file written next to the SKILL.md it pins. */
const SNAPSHOT_NAME = ".kit-skill.snapshot.json";

/** Resolve the SKILL.md path from an arg that may point at a file or its directory. */
function resolveSkillPath(arg: string): string | null {
  const p = resolve(process.cwd(), arg);
  if (existsSync(p) && statSync(p).isFile()) return p;
  const asDir = join(p, "SKILL.md");
  if (existsSync(asDir)) return asDir;
  return null;
}

/**
 * Discover sibling skills for collision detection: every OTHER `<dir>/SKILL.md` under the
 * target's parent-of-parent (the skills root), one level down. Best-effort and never
 * throws — an unreadable dir just yields no siblings (collision simply isn't evaluated).
 */
function discoverSiblings(skillPath: string): SiblingSkill[] {
  const siblings: SiblingSkill[] = [];
  const skillsRoot = dirname(dirname(skillPath)); // <root>/<skill>/SKILL.md
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return siblings;
  }
  for (const entry of entries) {
    const candidate = join(skillsRoot, entry, "SKILL.md");
    if (candidate === skillPath || !existsSync(candidate)) continue;
    try {
      const m = parseSkillManifest(readFileSync(candidate, "utf-8"));
      if (m.name) siblings.push({ name: m.name, triggerKey: triggerKey(m) });
    } catch {
      // unreadable sibling — skip it, never fail the run
    }
  }
  return siblings;
}

/** Load a committed snapshot next to the SKILL.md, or null when absent/malformed. */
function loadSnapshot(skillPath: string): SkillSnapshot | null {
  const path = join(dirname(skillPath), SNAPSHOT_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SkillSnapshot;
  } catch {
    return null;
  }
}

function mark(status: CheckResult["status"]): string {
  if (status === "pass") return `${c.green}✓${c.reset}`;
  if (status === "fail") return `${c.red}✗${c.reset}`;
  return `${c.yellow}−${c.reset}`; // skip
}

/**
 * Denied forbidden attempts for a skill, from `.kit-audit.jsonl` gate-deny records attributed to
 * its run windows via the `session_id` join key. Best-effort: no audit log / unreadable → no
 * denial evidence, never breaks the audit.
 */
async function gatherDenialActions(db: DatabaseSync, skillName: string): Promise<ObservedAction[]> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const jsonl = readFileSync(resolve(process.cwd(), ".kit-audit.jsonl"), "utf-8");
    const { readToolCallRows, targetSpanWindows } = await import("../skill/attribute.js");
    const { parseGateDenials, denialActionsForSkill } = await import("../skill/denials.js");
    const windows = targetSpanWindows(readToolCallRows(db), skillName);
    return denialActionsForSkill(windows, parseGateDenials(jsonl));
  } catch {
    return [];
  }
}

/**
 * Gather the two runtime checks (adherence, negative controls) from the transcript index.
 * Missing names or unavailable indexes produce skips. The runtime gate requires both checks to pass.
 * The pure `auditRuntime` decides; this function reads evidence without migration.
 */
async function gatherRuntime(
  skillName: string,
  allowedTools: string[] | undefined,
): Promise<{ checks: RuntimeCheckResult[]; summary: RuntimeEvidenceSummary | null }> {
  const skipBoth = (reason: string): { checks: RuntimeCheckResult[]; summary: null } => ({
    checks: [
      { id: "adherence", status: "skip", detail: reason },
      { id: "negative", status: "skip", detail: reason },
    ],
    summary: null,
  });
  if (!skillName)
    return skipBoth("no name in frontmatter; cannot attribute recorded runs to this skill");
  let evidence: RuntimeEvidence;
  let db: DatabaseSync | undefined;
  try {
    const { openMemoryDbReadOnly } = await import("../memory/db.js");
    db = openMemoryDbReadOnly();
    // A signed broker scope enriches actions with egress/fs target-scope verdicts; absent one,
    // tool-scope adherence still applies. A missing/invalid policy must never break the audit.
    let policy = null;
    try {
      const { profileBrokerPolicy } = await import("../exec-broker/profile-policy.js");
      policy = (await profileBrokerPolicy(process.cwd())).policy;
    } catch {
      /* No verified scope; check tool scope only. */
    }
    // Denial evidence: gate-deny records in .kit-audit.jsonl, attributed to this skill's run
    // windows by session_id. Only structured gate denials establish blocked requests.
    const denialActions = await gatherDenialActions(db, skillName);
    evidence = readRunEvidence(db, skillName, { policy, denialActions });
  } catch {
    return skipBoth("transcript index unavailable; runtime audit skipped");
  } finally {
    db?.close();
  }
  return auditRuntime(allowedTools, evidence);
}

interface SkillTestRender {
  name: string;
  checks: CheckResult[];
  runtime: boolean;
  runtimeChecks: RuntimeCheckResult[];
  runtimeEvidence: RuntimeEvidenceSummary | null;
  disclaimed: readonly DisclaimedItem[];
  overallOk: boolean;
  hasSkips: boolean;
  json: boolean;
}

/** Render the folded static + (optional) runtime report as JSON or human output. */
function renderResult(r: SkillTestRender): void {
  if (r.json) {
    console.log(
      JSON.stringify(
        {
          skill: r.name,
          checks: r.checks,
          ...(r.runtime ? { runtime: r.runtimeChecks, runtimeEvidence: r.runtimeEvidence } : {}),
          disclaimed: r.disclaimed,
          ok: r.overallOk,
          hasSkips: r.hasSkips,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `${c.bold}kit skill test${c.reset} ${c.dim}${r.name} — module-discipline checks (deterministic)${c.reset}`,
  );
  for (const ch of r.checks) {
    console.log(`  ${mark(ch.status)} ${ch.id.padEnd(11)} ${c.dim}${ch.detail}${c.reset}`);
  }
  if (r.runtime) {
    console.log(`  ${c.dim}runtime (recorded-run audit):${c.reset}`);
    for (const ch of r.runtimeChecks) {
      console.log(`  ${mark(ch.status)} ${ch.id.padEnd(11)} ${c.dim}${ch.detail}${c.reset}`);
    }
  }
  console.log(`\n  ${c.dim}not decided here (by design):${c.reset}`);
  for (const d of r.disclaimed) {
    console.log(`  ${c.dim}·${c.reset} ${c.dim}${d.id.padEnd(16)} ${d.reason}${c.reset}`);
  }
  if (r.overallOk) {
    const note = r.hasSkips
      ? "(some checks skipped — see above)"
      : "(engineered like a module; not a judgement of quality)";
    console.log(`\n${c.green}module discipline: ok${c.reset} ${c.dim}${note}${c.reset}`);
  } else {
    const incomplete =
      ![...r.checks, ...r.runtimeChecks].some((check) => check.status === "fail") &&
      r.runtimeChecks.some((check) => check.status === "skip");
    console.log(
      incomplete
        ? `\n${c.yellow}module discipline: incomplete${c.reset} ${c.dim}(required runtime evidence is incomplete)${c.reset}`
        : `\n${c.red}module discipline: fail${c.reset} ${c.dim}(a check failed; see above)${c.reset}`,
    );
  }
}

export async function cmdSkill(): Promise<boolean> {
  const sub = process.argv[3];
  const args = process.argv.slice(4);
  const json = hasFlag(process.argv, "--json");

  if (sub !== "test") {
    console.error(
      `${c.red}usage: kit skill test <path-to-SKILL.md|skill-dir> [--runtime] [--json] [--gate] [--update-snapshot]${c.reset}`,
    );
    return false;
  }

  const target = args.find((a) => !a.startsWith("-")) ?? flagValue(process.argv, "--path");
  if (!target) {
    console.error(
      `${c.red}usage: kit skill test <path-to-SKILL.md|skill-dir> [--runtime] [--json] [--gate] [--update-snapshot]${c.reset}`,
    );
    return false;
  }

  const skillPath = resolveSkillPath(target);
  if (!skillPath) {
    if (json)
      console.log(JSON.stringify({ ok: false, error: `SKILL.md not found at ${target}` }, null, 2));
    else console.error(`${c.red}✗ no SKILL.md found at ${target}${c.reset}`);
    return false;
  }

  const manifest = parseSkillManifest(readFileSync(skillPath, "utf-8"));

  // --update-snapshot: pin the current module surface and exit (a deliberate operator act).
  if (hasFlag(process.argv, "--update-snapshot")) {
    const snap = snapshotOf(manifest);
    const snapPath = join(dirname(skillPath), SNAPSHOT_NAME);
    writeFileSync(snapPath, JSON.stringify(snap, null, 2) + "\n", "utf-8");
    if (json)
      console.log(JSON.stringify({ updated: true, snapshot: snap, path: snapPath }, null, 2));
    else
      console.log(
        `${c.green}✓ snapshot pinned${c.reset} ${c.dim}${snapPath} (${snap.fingerprint})${c.reset}`,
      );
    return true;
  }

  return runSkillTest(skillPath, manifest, json);
}

async function runSkillTest(
  skillPath: string,
  manifest: ReturnType<typeof parseSkillManifest>,
  json: boolean,
): Promise<boolean> {
  const report = testSkill(manifest, {
    siblings: discoverSiblings(skillPath),
    snapshot: loadSnapshot(skillPath),
  });

  // --runtime opts into the recorded-run audit; it upgrades the adherence + negative-control
  // rows from disclaimed-OUT to real verdicts. rubric stays OUT forever (LLM — delegated).
  const runtime = hasFlag(process.argv, "--runtime");
  const runtimeAudit = runtime
    ? await gatherRuntime(manifest.name ?? "", manifest.allowedTools)
    : null;
  const runtimeChecks = runtimeAudit?.checks ?? [];
  const disclaimed = runtime
    ? report.disclaimed.filter((d) => d.id === "rubric")
    : report.disclaimed;
  const runtimeOk = runtimeChecks.every((r) => r.status === "pass");
  const overallOk = report.ok && runtimeOk;
  const hasSkips = report.hasSkips || runtimeChecks.some((r) => r.status === "skip");

  renderResult({
    name: manifest.name ?? basename(dirname(skillPath)),
    checks: report.checks,
    runtime,
    runtimeChecks,
    runtimeEvidence: runtimeAudit?.summary ?? null,
    disclaimed,
    overallOk,
    hasSkips,
    json,
  });

  // Required runtime checks must pass. Skips keep the gate closed; advisory mode still exits zero.
  return hasFlag(process.argv, "--gate") ? overallOk : true;
}
