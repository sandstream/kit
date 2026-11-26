/**
 * Default skill posture, for `kit agent-audit`: which skills the agent has in this checkout
 * (`<dir>/<name>/SKILL.md` for Claude Code's `.claude/skills` and Codex's `.agents/skills` and
 * `.codex/skills`) and at user level (`~/.claude/skills`, `~/.agents/skills` and the Codex home's
 * `skills`), what tools each declares (`allowed-tools`), and who may invoke it.
 *
 * `kit skill test` already judges one skill's scope. What nobody printed was the set the agent is
 * actually carrying, with the spec defaults written out. A skill with no `allowed-tools` claims every
 * tool, and one without `disable-model-invocation` may be invoked by the model on its own; both are
 * the defaults, so a skill that says nothing is the one with the widest posture. Each row says which
 * values were declared and which are defaults. Read-only; nothing is run.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_SKILL_DIRS } from "./agent-sbom.js";
import { codexHome } from "./agent-audit-user.js";
import type { SecurityCheckResult } from "./check-security.js";
import { parseSkillManifest, type SkillManifest } from "./skill/test.js";
import { shown } from "./agent-trifecta.js";

type SkillScope = "project" | "user";

interface SkillPosture {
  scope: SkillScope;
  /** The skill's directory name. */
  dir: string;
  /** The skills directory it is in, as shown: `.claude/skills`, `~/.agents/skills`, … */
  base: string;
  manifest: SkillManifest | null;
}

/** The skill dirs under `base` that hold a SKILL.md, sorted. Missing base → []. */
function skillDirs(base: string): string[] {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  return names.filter((n) => isFile(join(base, n, "SKILL.md"))).sort();
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readManifest(path: string): SkillManifest | null {
  try {
    return parseSkillManifest(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** [scope, absolute dir, shown] for every skills directory Claude Code or Codex loads. */
function skillBases(
  cwd: string,
  home: string,
  env: Record<string, unknown>,
): [SkillScope, string, string][] {
  const bases: [SkillScope, string, string][] = PROJECT_SKILL_DIRS.map((rel) => [
    "project",
    join(cwd, ...rel.split("/")),
    rel,
  ]);
  if (realOrSelf(cwd) === realOrSelf(home)) return bases;
  const codex = codexHome(home, env);
  bases.push(
    ["user", join(home, ".claude", "skills"), "~/.claude/skills"],
    ["user", join(home, ".agents", "skills"), "~/.agents/skills"],
    ["user", join(codex.dir, "skills"), `${codex.shown}/skills`],
  );
  return bases;
}

/**
 * Every installed skill, project first, Claude Code's directory before Codex's. A SKILL.md reached
 * twice (a skill linked from `~/.agents/skills` into `~/.claude/skills`, or a checkout that is the
 * home directory) is listed once.
 */
export function readSkillPostures(
  cwd: string,
  home: string,
  env: Record<string, unknown> = {},
): SkillPosture[] {
  const out: SkillPosture[] = [];
  const seen = new Set<string>();
  for (const [scope, abs, base] of skillBases(cwd, home, env)) {
    for (const dir of skillDirs(abs)) {
      const file = join(abs, dir, "SKILL.md");
      const real = realOrSelf(file);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ scope, dir, base, manifest: readManifest(file) });
    }
  }
  return out;
}

/** `allowed-tools` as one phrase, and whether it is a bounded declaration. */
export function toolsPhrase(m: SkillManifest): { text: string; bounded: boolean } {
  const tools = m.allowedTools;
  if (tools === undefined) return { text: "allowed-tools not declared: all tools", bounded: false };
  if (tools.some((t) => t === "*" || t === "all"))
    return { text: `allowed-tools: ${tools.map(shown).join(", ")} (wildcard)`, bounded: false };
  if (tools.length === 0) return { text: "allowed-tools: none", bounded: true };
  return { text: `allowed-tools: ${tools.map(shown).join(", ")}`, bounded: true };
}

/** Who may invoke the skill, with `(default)` on each value the skill did not declare. */
export function invocationPhrase(m: SkillManifest): string {
  const model =
    m.disableModelInvocation === undefined
      ? "model-invocable (default)"
      : m.disableModelInvocation
        ? "model-invocation disabled"
        : "model-invocable";
  const user =
    m.userInvokable === undefined
      ? "user-invokable (default)"
      : m.userInvokable
        ? "user-invokable"
        : "not user-invokable";
  return `${model}, ${user}`;
}

function row(status: "pass" | "warn", name: string, detail: string): SecurityCheckResult {
  return { category: "exposure", name, status, detail };
}

function postureRow(p: SkillPosture): SecurityCheckResult {
  const where = p.base.endsWith(".claude/skills") ? "" : `, ${p.base}`;
  const label = `skill ${shown(p.dir)} (${p.scope}${where})`;
  if (!p.manifest) return row("warn", label, "SKILL.md could not be read");
  const tools = toolsPhrase(p.manifest);
  const detail = `${tools.text}; ${invocationPhrase(p.manifest)}`;
  return row(tools.bounded ? "pass" : "warn", label, detail);
}

/**
 * One row per installed skill. An undeclared or wildcard `allowed-tools` is a `warn`, the same
 * judgement `kit skill test` makes; nothing here is a `fail`, so the exit code of
 * `kit agent-audit` does not change.
 */
export function runAgentSkillPosture(
  cwd: string,
  home: string,
  env: Record<string, unknown> = {},
): SecurityCheckResult[] {
  const postures = readSkillPostures(cwd, home, env);
  if (postures.length === 0) {
    return [
      row(
        "pass",
        "skill posture",
        "no skills in .claude/skills, .agents/skills or .codex/skills here or at user level",
      ),
    ];
  }
  const project = postures.filter((p) => p.scope === "project").length;
  const summary = row(
    "pass",
    "skill posture",
    `${postures.length} skill(s): ${project} in this checkout, ${postures.length - project} at user level`,
  );
  return [summary, ...postures.map(postureRow)];
}
