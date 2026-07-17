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
 *
 * Design: `kit-research/docs/research/skills-as-software-modules.md`.
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
import { auditRuntime, type RuntimeCheckResult, type RuntimeEvidence } from "../skill/adherence.js";
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
 * Gather the two runtime checks (adherence, negative controls) from the transcript index.
 * Honest skips when the skill has no name to attribute by, or the index is unavailable —
 * never a silent pass. The pure `auditRuntime` decides; this only sources the evidence.
 */
async function gatherRuntime(
  skillName: string,
  allowedTools: string[] | undefined,
): Promise<RuntimeCheckResult[]> {
  const skipBoth = (reason: string): RuntimeCheckResult[] => [
    { id: "adherence", status: "skip", detail: reason },
    { id: "negative", status: "skip", detail: reason },
  ];
  if (!skillName)
    return skipBoth("no name in frontmatter — cannot attribute recorded runs to this skill");
  let evidence: RuntimeEvidence;
  try {
    const { openMemoryDb } = await import("../memory/db.js");
    const db = openMemoryDb();
    evidence = readRunEvidence(db, skillName);
  } catch {
    return skipBoth("transcript index unavailable — runtime audit skipped");
  }
  return auditRuntime(allowedTools, evidence).checks;
}

interface SkillTestRender {
  name: string;
  checks: CheckResult[];
  runtime: boolean;
  runtimeChecks: RuntimeCheckResult[];
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
          ...(r.runtime ? { runtime: r.runtimeChecks } : {}),
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
    console.log(
      `\n${c.red}module discipline: fail${c.reset} ${c.dim}(a check failed — see above)${c.reset}`,
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

  const report = testSkill(manifest, {
    siblings: discoverSiblings(skillPath),
    snapshot: loadSnapshot(skillPath),
  });

  // --runtime opts into the recorded-run audit; it upgrades the adherence + negative-control
  // rows from disclaimed-OUT to real verdicts. rubric stays OUT forever (LLM — delegated).
  const runtime = hasFlag(process.argv, "--runtime");
  const runtimeChecks = runtime
    ? await gatherRuntime(manifest.name ?? "", manifest.allowedTools)
    : [];
  const disclaimed = runtime
    ? report.disclaimed.filter((d) => d.id === "rubric")
    : report.disclaimed;
  const runtimeOk = runtimeChecks.every((r) => r.status !== "fail");
  const overallOk = report.ok && runtimeOk;
  const hasSkips = report.hasSkips || runtimeChecks.some((r) => r.status === "skip");

  renderResult({
    name: manifest.name ?? basename(dirname(skillPath)),
    checks: report.checks,
    runtime,
    runtimeChecks,
    disclaimed,
    overallOk,
    hasSkips,
    json,
  });

  // --gate makes any failure a non-zero exit for CI; without it, the report is advisory.
  return hasFlag(process.argv, "--gate") ? overallOk : true;
}
