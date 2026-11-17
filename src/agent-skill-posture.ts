/**
 * Default skill posture, for `kit agent-audit`: which skills the agent has in this checkout
 * (`.claude/skills/<name>/SKILL.md`) and at user level (`~/.claude/skills/<name>/SKILL.md`), what
 * tools each declares (`allowed-tools`), and who may invoke it.
 *
 * `kit skill test` already judges one skill's scope. What nobody printed was the set the agent is
 * actually carrying, with the spec defaults written out. A skill with no `allowed-tools` claims every
 * tool, and one without `disable-model-invocation` may be invoked by the model on its own; both are
 * the defaults, so a skill that says nothing is the one with the widest posture. Each row says which
 * values were declared and which are defaults. Read-only; nothing is run.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { parseSkillManifest, type SkillManifest } from "./skill/test.js";
import { shown } from "./agent-trifecta.js";

type SkillScope = "project" | "user";

interface SkillPosture {
  scope: SkillScope;
  /** The directory name under `.claude/skills`. */
  dir: string;
  manifest: SkillManifest | null;
}

/** The skill dirs under `root/.claude/skills` that hold a SKILL.md, sorted. Missing root → []. */
function skillDirs(root: string): string[] {
  const base = join(root, ".claude", "skills");
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

/** Every installed skill, project first. When the checkout is the home directory, once. */
export function readSkillPostures(cwd: string, home: string): SkillPosture[] {
  const roots: [SkillScope, string][] = [["project", cwd]];
  if (realOrSelf(cwd) !== realOrSelf(home)) roots.push(["user", home]);
  const out: SkillPosture[] = [];
  for (const [scope, root] of roots) {
    for (const dir of skillDirs(root)) {
      const file = join(root, ".claude", "skills", dir, "SKILL.md");
      out.push({ scope, dir, manifest: readManifest(file) });
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
  const label = `skill ${shown(p.dir)} (${p.scope})`;
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
export function runAgentSkillPosture(cwd: string, home: string): SecurityCheckResult[] {
  const postures = readSkillPostures(cwd, home);
  if (postures.length === 0) {
    return [
      row("pass", "skill posture", "no skills in .claude/skills here or in ~/.claude/skills"),
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
