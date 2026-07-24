/**
 * `kit skill test` — deterministic module-discipline linter for a `SKILL.md` (P1).
 *
 * Design: `kit-research/docs/research/skills-as-software-modules.md`.
 *
 * Thesis: an agent skill is becoming a software MODULE, so it inherits the module
 * lifecycle — a declared contract, trigger discipline, a least-privilege scope, and CI
 * regression. Six of the seven SE practices in the note are deterministic (kit's
 * zero-LLM wheelhouse); one — rubric grading, "is the output any GOOD?" — is
 * irreducibly an LLM judgement and is DELEGATED to an eval harness, never run here.
 *
 * This module is the DECISION half — pure, no I/O, no spawning — for the four checks
 * that are a pure function of the manifest (+ its sibling skills, + a committed
 * snapshot):
 *   contract    — required frontmatter present + shaped        (definition of done)
 *   trigger     — a trigger is declared + no sibling collision  (trigger tests, det. half)
 *   scope       — least-privilege manifest declared (bounded)   (least-privilege, declared half)
 *   regression  — contract+trigger+scope fingerprint vs snapshot (CI regression)
 *
 * HONEST SEAMS — stated in the output, never papered over:
 *   - negative controls + runtime scope ADHERENCE ("does it refrain from / stay within
 *     its declared scope when it actually RUNS") need the skill executed under the
 *     exec-broker (observe/enforce). That is a runtime pass (P2), not this static one —
 *     reported as OUT here, so a clean static run never reads as "proven at runtime".
 *   - rubric grading is LLM — DELEGATED, never kit. Reported OUT.
 * `kit skill test` proves a skill is ENGINEERED like a module; it does NOT judge whether
 * the skill is GOOD. The name must never imply quality grading.
 */
import { createHash } from "node:crypto";

/** Parsed shape of a `SKILL.md` — only the fields the module checks care about. */
export interface SkillManifest {
  /** Frontmatter `name`. */
  name?: string;
  /** Frontmatter `description` — in the Claude skill format this IS the trigger. */
  description?: string;
  /**
   * `allowed-tools` / `allowed_tools`, normalized to a list:
   *   - `undefined` → the key was absent (skill implicitly claims ALL tools — not least-privilege)
   *   - `[]`        → declared but empty (maximally restrictive)
   *   - `[...]`     → a bounded tool list
   */
  allowedTools?: string[];
  /**
   * agentskills.io invocation control — whether a human may trigger the skill via a
   * slash command. `undefined` → field absent (spec default: user-invokable).
   */
  userInvokable?: boolean;
  /**
   * agentskills.io invocation control — whether the AGENT may autonomously invoke the
   * skill. `undefined` → field absent (spec default: model MAY invoke). `true` means the
   * model is forbidden from auto-invoking (restrict sensitive ops to user-only).
   */
  disableModelInvocation?: boolean;
  /** The markdown body after the frontmatter block (trimmed). */
  body: string;
  /** True when a `---` frontmatter block was found at all. */
  hasFrontmatter: boolean;
}

/** Parse a frontmatter boolean scalar (`true`/`false`, case-insensitive); undefined otherwise. */
function parseBool(v: string): boolean | undefined {
  const s = v.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

/** Split a comma / inline-array / block-list frontmatter value into trimmed items. */
function parseList(raw: string, blockItems: string[]): string[] {
  const inline = raw.trim();
  if (inline.length > 0) {
    // `[a, b]` or `a, b`
    const stripped = inline.replace(/^\[/, "").replace(/\]$/, "");
    return stripped
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
  }
  return blockItems;
}

/** Strip surrounding quotes from a scalar frontmatter value. */
function unquote(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "");
}

/**
 * Minimal, dependency-free `SKILL.md` parser. Handles a leading `---` frontmatter block
 * with `key: value` scalars and `allowed-tools` in inline (`[a, b]` / `a, b`) or YAML
 * block-list (`- item`) form. Pure. Never throws — malformed input yields a manifest with
 * `hasFrontmatter: false` and the whole text as the body.
 */
export function parseSkillManifest(raw: string): SkillManifest {
  const text = raw.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) {
    return { body: text.trim(), hasFrontmatter: false };
  }
  const [, frontmatter, body] = fm;
  const lines = frontmatter.split("\n");

  const manifest: SkillManifest = { body: body.trim(), hasFrontmatter: true };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2];

    if (key === "name") manifest.name = unquote(value);
    else if (key === "description") manifest.description = unquote(value);
    else if (key === "user-invokable" || key === "user_invokable")
      manifest.userInvokable = parseBool(value);
    else if (key === "disable-model-invocation" || key === "disable_model_invocation")
      manifest.disableModelInvocation = parseBool(value);
    else if (key === "allowed-tools" || key === "allowed_tools") {
      // Collect any following `  - item` block-list lines.
      const blockItems: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+-\s+(.*)$/);
        if (!item) break;
        blockItems.push(unquote(item[1]));
      }
      manifest.allowedTools = parseList(value, blockItems);
    }
  }

  return manifest;
}

export type CheckId = "contract" | "trigger" | "scope" | "regression";
/** `pass`/`fail` are verdict-bearing; `skip` is honest "precondition absent" (neutral). */
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  detail: string;
}

/** A sibling skill to compare triggers against (name + its normalized trigger key). */
export interface SiblingSkill {
  name: string;
  triggerKey: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MIN_DESCRIPTION = 12;

/**
 * Contract — required frontmatter present + shaped. A skill must DECLARE its identity and
 * purpose: a `---` block, a slug-shaped `name`, a non-trivial `description` (this is the
 * when/purpose in the Claude format), and a non-empty body. Presence + shape only — no
 * judgement of whether the declared purpose is any good. Pure.
 */
export function checkContract(m: SkillManifest): CheckResult {
  const c = (status: CheckStatus, detail: string): CheckResult => ({
    id: "contract",
    status,
    detail,
  });
  if (!m.hasFrontmatter)
    return c("fail", "no --- frontmatter block (a module must declare its contract)");
  if (!m.name) return c("fail", "frontmatter has no name");
  if (!SLUG_RE.test(m.name))
    return c("fail", `name "${m.name}" is not slug-shaped (lowercase, digits, dashes)`);
  if (!m.description || m.description.trim().length < MIN_DESCRIPTION)
    return c("fail", "description missing or too short to declare when/why the skill applies");
  if (m.body.length === 0) return c("fail", "empty body — no declared steps / definition of done");
  return c("pass", `name + description + body declared (${m.name})`);
}

/**
 * Normalized trigger key: the lowercased, whitespace-collapsed, punctuation-stripped
 * description. Two skills whose descriptions normalize to the same key claim the same
 * trigger. Pure — empty when no description.
 */
export function triggerKey(m: SkillManifest): string {
  return (m.description ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Trigger — the deterministic half of trigger tests. Fails when no trigger is declared,
 * or when the trigger COLLIDES with a sibling skill (identical normalized trigger key).
 * Whether the trigger *should* fire for a given fuzzy NL prompt is a judgement → an eval
 * harness, explicitly NOT this check. Pure.
 */
export function checkTrigger(m: SkillManifest, siblings: SiblingSkill[] = []): CheckResult {
  const t = (status: CheckStatus, detail: string): CheckResult => ({
    id: "trigger",
    status,
    detail,
  });
  const key = triggerKey(m);
  if (key.length === 0)
    return t("fail", "no description — nothing declares when the skill triggers");
  const collision = siblings.find((s) => s.name !== m.name && s.triggerKey === key);
  if (collision) return t("fail", `trigger collides with sibling skill "${collision.name}"`);
  return siblings.length > 0
    ? t("pass", `trigger declared, no collision across ${siblings.length} sibling skill(s)`)
    : t("pass", "trigger declared (no sibling skills to compare)");
}

/**
 * Scope — the DECLARED-least-privilege half. `allowed-tools` must be present and bounded:
 * absent means the skill implicitly claims every tool; a `*` wildcard is not
 * least-privilege. An empty list is the most restrictive (pass). This proves the skill
 * DECLARES a bounded scope — proving it STAYS in scope when it runs is the exec-broker's
 * runtime job (P2), disclaimed separately. Pure.
 */
export function checkScope(m: SkillManifest): CheckResult {
  const posture = skillInvocationPosture(m);
  const suffix = posture ? ` [${posture}]` : "";
  const s = (status: CheckStatus, detail: string): CheckResult => ({
    id: "scope",
    status,
    detail: detail + suffix,
  });
  if (m.allowedTools === undefined)
    return s(
      "fail",
      "no allowed-tools declared — skill implicitly claims ALL tools (not least-privilege)",
    );
  if (m.allowedTools.some((t) => t === "*" || t === "all"))
    return s("fail", "allowed-tools contains a wildcard (*) — not least-privilege");
  if (m.allowedTools.length === 0)
    return s("pass", "declares zero tools (maximally least-privilege)");
  return s("pass", `declares a bounded scope of ${m.allowedTools.length} tool(s)`);
}

/**
 * agentskills.io invocation posture — a short, deterministic description of who may
 * trigger the skill, derived from the `user-invokable` / `disable-model-invocation`
 * fields. `null` when neither field is present (nothing to report). Advisory: it
 * enriches the scope detail; it does not change the pass/fail verdict. The higher-risk
 * posture is "model-invocable" with a broad tool surface — surfaced here so a reviewer
 * (or `kit triage skill`) can weigh the autonomous-exposure surface.
 */
export function skillInvocationPosture(m: SkillManifest): string | null {
  if (m.userInvokable === undefined && m.disableModelInvocation === undefined) return null;
  const modelPart = m.disableModelInvocation === true ? "model-invocation disabled" : "model-invocable";
  const userPart = m.userInvokable === false ? "not user-invokable" : "user-invokable";
  return `${modelPart}, ${userPart}`;
}

/** The canonical, snapshot-able facts about a skill module (order-stable). */
export interface SkillSnapshot {
  name: string;
  triggerKey: string;
  scope: string[];
  fingerprint: string;
}

/** Canonical bytes for fingerprinting: name + trigger key + sorted declared scope. Pure. */
function canonicalSkillBytes(m: SkillManifest): string {
  return JSON.stringify({
    name: m.name ?? "",
    triggerKey: triggerKey(m),
    scope: [...(m.allowedTools ?? [])].sort(),
  });
}

/** Short content fingerprint of a skill module's contract+trigger+scope. Pure. */
export function skillFingerprint(m: SkillManifest): string {
  return "sha256:" + createHash("sha256").update(canonicalSkillBytes(m)).digest("hex").slice(0, 16);
}

/** Build the snapshot object for a manifest (what `--update-snapshot` writes). Pure. */
export function snapshotOf(m: SkillManifest): SkillSnapshot {
  return {
    name: m.name ?? "",
    triggerKey: triggerKey(m),
    scope: [...(m.allowedTools ?? [])].sort(),
    fingerprint: skillFingerprint(m),
  };
}

/**
 * Regression — the CI half. Compares the current module fingerprint against a committed
 * snapshot; unreviewed drift is a fail (the skill quietly changed what it can do), exactly
 * like `public-surface.json` drift. No snapshot yet is an honest `skip`, never a pass —
 * the caller pins it with `--update-snapshot`. Pure.
 */
export function checkRegression(m: SkillManifest, snapshot: SkillSnapshot | null): CheckResult {
  const r = (status: CheckStatus, detail: string): CheckResult => ({
    id: "regression",
    status,
    detail,
  });
  if (!snapshot)
    return r(
      "skip",
      "no committed snapshot — run with --update-snapshot to pin the module surface",
    );
  const now = skillFingerprint(m);
  if (now === snapshot.fingerprint) return r("pass", `matches committed snapshot (${now})`);
  return r("fail", `module surface drifted: snapshot ${snapshot.fingerprint} → now ${now}`);
}

/** Items kit deliberately does NOT decide here — surfaced so a clean run never overclaims. */
export interface DisclaimedItem {
  id: "negative-controls" | "scope-adherence" | "rubric";
  reason: string;
}

export const DISCLAIMED: readonly DisclaimedItem[] = [
  {
    id: "negative-controls",
    reason:
      "proving a skill REFRAINS from forbidden actions needs it run under the exec-broker (observe/enforce) — a runtime pass (P2), not this static one",
  },
  {
    id: "scope-adherence",
    reason:
      "proving a skill STAYS within its declared scope needs runtime broker mediation (P2); this pass proves only that scope is DECLARED",
  },
  {
    id: "rubric",
    reason:
      "grading whether the skill's output is GOOD is an LLM judgement — delegated to an eval harness, never run by kit (zero-LLM boundary)",
  },
];

export interface SkillTestReport {
  checks: CheckResult[];
  disclaimed: readonly DisclaimedItem[];
  /** True unless any check failed. A `skip` is neutral (surfaced, never a silent pass). */
  ok: boolean;
  /** True when a verdict-bearing check could not run (skipped) — worth surfacing. */
  hasSkips: boolean;
}

/** Run the four deterministic module checks and fold them into one honest report. Pure. */
export function testSkill(
  m: SkillManifest,
  opts: { siblings?: SiblingSkill[]; snapshot?: SkillSnapshot | null } = {},
): SkillTestReport {
  const checks: CheckResult[] = [
    checkContract(m),
    checkTrigger(m, opts.siblings ?? []),
    checkScope(m),
    checkRegression(m, opts.snapshot ?? null),
  ];
  return {
    checks,
    disclaimed: DISCLAIMED,
    ok: !checks.some((c) => c.status === "fail"),
    hasSkips: checks.some((c) => c.status === "skip"),
  };
}
