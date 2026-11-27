/**
 * Rules an agent skill states that no `.kit/standards.d` rule checks.
 *
 * A skill asks the agent to follow a rule; a standards rule enforces it. A line in a skill such as
 * "Never call `Guid.NewGuid()`" depends on the agent reading the skill and remembering that line,
 * and agents, models and clients differ in whether they do. This lists the skill lines that state
 * a rule about a piece of code (a rule word plus a code token in backticks) when no declarative
 * standards rule finds that token, so the owner can see which rules rest on the agent's memory.
 *
 * Text over text, no model (ADR-0001), the same for every harness's skills. It does not judge
 * whether a rule should be a gate, and the skill line should stay: it helps the agent get it right
 * the first time. A warning, never a failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkSourceFiles } from "./source-walk.js";
import type { StandardsCheckResult } from "./check-standards.js";
import type { StandardPluginSpec } from "./standards-plugins.js";

/** Project skill directories of Claude Code, Codex and the shared `.agents` layout. */
export const SKILL_DIRS = [".claude/skills", ".agents/skills", ".codex/skills"];

const RULE_WORD_EN = /\b(never|must not|mustn't|do not|don't|always|forbid(?:den)?|avoid)\b/i;
/** Skills are often written in the team's language; this reads Swedish rule words, it does not speak them. */
export const RULE_WORD_SV = /\b(aldrig|förbjud\w*|undvik)\b/i;
export const isRuleLine = (text: string): boolean =>
  RULE_WORD_EN.test(text) || RULE_WORD_SV.test(text);
export const CODE_TOKEN = /`([^`\n]{2,80})`/g;
/** A token that names code rather than an ordinary word: punctuation, a call or camelCase. */
export const CODE_SHAPE = /[.()*_:<>[\]/]|[a-z][A-Z]/;

export interface UngatedSkillRule {
  file: string;
  line: number;
  token: string;
}

/** Turn `*Event` into a sample a rule could match; strip nothing else. */
const sampleOf = (token: string): string => token.replace(/\*/g, "Sample");
const bare = (token: string): string => token.replace(/[*()]/g, "").trim().toLowerCase();

function gated(token: string, plugins: StandardPluginSpec[]): boolean {
  const word = bare(token);
  return plugins.some((p) => {
    try {
      if (new RegExp(p.match).test(sampleOf(token))) return true;
    } catch {
      // An invalid pattern never loads, so this is defensive only.
    }
    const text = `${p.id} ${p.title} ${p.because ?? ""}`.toLowerCase();
    return word.length > 0 && text.includes(word);
  });
}

/** Every skill line that states a rule about a code token no standards rule checks. */
export function findUngatedSkillRules(
  cwd: string,
  plugins: StandardPluginSpec[],
  dirs: string[] = SKILL_DIRS,
): UngatedSkillRule[] {
  const out: UngatedSkillRule[] = [];
  for (const dir of dirs) {
    const abs = join(cwd, ...dir.split("/"));
    if (!existsSync(abs)) continue;
    let files: string[];
    try {
      files = walkSourceFiles(abs, { exts: [".md"], includeTests: true });
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const rel = relative(cwd, file).split(sep).join("/");
      let lines: string[];
      try {
        lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
      } catch {
        continue;
      }
      lines.forEach((text, i) => {
        if (!isRuleLine(text)) return;
        for (const m of text.matchAll(CODE_TOKEN)) {
          const token = m[1]!.trim();
          if (CODE_SHAPE.test(token) && !gated(token, plugins)) {
            out.push({ file: rel, line: i + 1, token });
          }
        }
      });
    }
  }
  return out;
}

/** The standards row, or nothing when no skill states a rule about code. */
export function skillRuleGateRows(
  cwd: string,
  plugins: StandardPluginSpec[],
): StandardsCheckResult[] {
  const ungated = findUngatedSkillRules(cwd, plugins);
  if (ungated.length === 0) return [];
  return [
    {
      category: "standards",
      dimension: "plugin",
      name: "skill rules without a gate",
      status: "warn",
      severity: "low",
      detail:
        `${ungated.length} rule(s) in agent skills name code that no .kit/standards.d rule checks, ` +
        "so they hold only while the agent reads and follows the skill; a rule that must never " +
        "break belongs in .kit/standards.d too",
      files: ungated.slice(0, 10).map((u) => `${u.file}:${u.line} (${u.token})`),
    },
  ];
}
