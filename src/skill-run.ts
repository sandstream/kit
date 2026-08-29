/**
 * The skill-discipline gate — the embeddable half of `kit skill test`, for `kit review` and CI.
 *
 * WHY THIS FILE EXISTS. `kit skill test --gate` has always exited 1 on a failing skill, and
 * nothing ever called it: not CI, not `kit review`, not `verify-suite.sh`. Measured on kit
 * itself the day this landed, kit's ONLY shipped `SKILL.md` failed kit's own linter (`scope:
 * no allowed-tools declared`) and no pipeline noticed for as long as the linter had existed.
 * That is the repo's own curated finding, verbatim: *"A gate that exists but is never invoked
 * is the default failure, not the exception."* This module is the invocation.
 *
 * WHAT IT DECIDES, AND WHAT IT REFUSES TO. Only module discipline: the contract is declared,
 * the trigger does not collide with a sibling, the tool scope is BOUNDED, and the module
 * surface still matches its committed snapshot. It never judges whether a skill's output is
 * good — that is a model judgement, delegated to an eval harness and never run by kit
 * (ADR-0001). A skill that passes here is well-engineered, not necessarily useful.
 *
 * NO SKILLS IS NOT A FAILURE, AND NOT A SILENT PASS. A repo that ships no `SKILL.md` gets an
 * honest not-applicable skip — `didNotRun` stays false, because nothing was prevented from
 * running; there was simply nothing to check. A repo that ships one gets a verdict.
 *
 * Deterministic and offline: parse, compare, hash. Pure except for reading the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { walkSourceFiles } from "./source-walk.js";
import {
  parseSkillManifest,
  testSkill,
  triggerKey,
  type SkillManifest,
  type SkillSnapshot,
  type SiblingSkill,
} from "./skill/test.js";
import type { JsonCheck } from "./cli-checks-shared.js";

/** Committed snapshot filename, kept in step with `kit skill test --update-snapshot`. */
export const SNAPSHOT_NAME = ".kit-skill.snapshot.json";

/**
 * Where a repo keeps skills. `skills/` is kit's own layout; `.claude/skills/` is the
 * agent-harness convention. Both are scanned, neither is required.
 */
export const SKILL_DIRS: readonly string[] = ["skills", ".claude/skills"];

export interface DiscoveredSkill {
  /** Repo-relative path to the SKILL.md. */
  path: string;
  manifest: SkillManifest;
  snapshot: SkillSnapshot | null;
}

function loadSnapshot(absSkillPath: string): SkillSnapshot | null {
  const p = join(dirname(absSkillPath), SNAPSHOT_NAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SkillSnapshot;
  } catch {
    return null; // malformed snapshot ⇒ treated as absent, which the regression check surfaces
  }
}

/** Every `SKILL.md` the repo ships, in a stable order. */
export function discoverSkills(cwd: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  for (const dir of SKILL_DIRS) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    for (const file of walkSourceFiles(abs, { exts: [".md"] })) {
      if (!file.endsWith("SKILL.md")) continue;
      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch {
        continue; // unreadable ⇒ not a skill we can judge; the walk is best-effort
      }
      out.push({
        path: relative(cwd, file).split("\\").join("/"),
        manifest: parseSkillManifest(raw),
        snapshot: loadSnapshot(file),
      });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface SkillGateResult {
  ok: boolean;
  /** How many `SKILL.md` files were found — 0 is a skip, never a pass. */
  skillCount: number;
  checks: JsonCheck[];
}

/**
 * Run module discipline over every skill in the repo.
 *
 * Each skill contributes one row per check, named `<skill>: <check>`, so a red row points at
 * the file and the rule rather than at "skills". Siblings are every OTHER discovered skill,
 * which is what makes trigger-collision detection meaningful in a repo that ships several.
 */
export function runSkillGate(cwd: string = process.cwd()): SkillGateResult {
  const skills = discoverSkills(cwd);
  if (skills.length === 0) {
    return {
      ok: true,
      skillCount: 0,
      checks: [
        {
          name: "skills",
          status: "skip",
          // Not-applicable, NOT a coverage loss: nothing was prevented from running.
          didNotRun: false,
          detail: `no SKILL.md found in ${SKILL_DIRS.join(" or ")} — nothing to check`,
          category: "skill",
        },
      ],
    };
  }

  const checks: JsonCheck[] = [];
  let ok = true;
  for (const skill of skills) {
    const label = skill.manifest.name ?? skill.path;
    const siblings: SiblingSkill[] = skills
      .filter((s) => s !== skill && s.manifest.name)
      .map((s) => ({ name: s.manifest.name!, triggerKey: triggerKey(s.manifest) }));
    const report = testSkill(skill.manifest, { siblings, snapshot: skill.snapshot });
    if (!report.ok) ok = false;
    for (const c of report.checks) {
      checks.push({
        name: `${label}: ${c.id}`,
        // A skipped module check is a real gap in what was proven, so it warns rather than
        // passing — but it never fails the gate on its own (`report.ok` ignores skips).
        status: c.status === "skip" ? "warn" : c.status,
        detail: c.detail,
        category: "skill",
        files: [skill.path],
        ...(c.status === "fail" ? { severity: "medium" as const } : {}),
      });
    }
  }
  return { ok, skillCount: skills.length, checks };
}
