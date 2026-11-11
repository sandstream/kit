/**
 * "Pwn request" shapes in a GitHub Actions workflow, read from its triggers and steps.
 *
 * The first version flagged any file whose text held both `pull_request_target` and
 * `actions/checkout`. Measured on six workflows (kit-research
 * `github-pull-request-target-default-block-vs-kit`), it was wrong four times:
 *   - it warned on a plain checkout, which under `pull_request_target` takes the BASE branch;
 *   - it warned on a push workflow whose comment only named the trigger;
 *   - it passed `gh pr checkout` in a `run:` step, which `actions/checkout` v7's refusal does not cover;
 *   - it passed a `workflow_run` workflow that checks out the triggering PR's head and runs it.
 *
 * Now: comments are stripped, the `on:` triggers are read, and a finding needs a privileged
 * trigger (one that runs with the base repository's secrets and write token) AND a step that
 * brings pull-request code in. Each finding names the shape. No YAML dependency (ADR-0002): this
 * reads the small subset of workflow syntax it needs, line by line. Pure.
 */

/** Triggers that run in the base repository's context, with its secrets, for a PR's event. */
export const PRIVILEGED_TRIGGERS = ["pull_request_target", "workflow_run", "issue_comment"];

/** GitHub blocks this trigger in public repositories without an allowing Actions event policy. */
export const PRT_DEFAULT_BLOCK_DATE = "2026-12-02";

/** The text with `#` comments removed. A `#` inside quotes or `${{ }}` is kept. */
export function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let quote = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1])))
          return line.slice(0, i).trimEnd();
      }
      return line;
    })
    .join("\n");
}

const ON_KEY = /^(?:on|"on"|'on'):\s*(.*)$/;

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

/**
 * The keys at the top level of a one-line flow mapping: `{ a: {x: [1]}, 'b': null }` gives
 * `a`, `b`. Nested `{}`/`[]` are skipped by depth, so a nested key never counts.
 */
function flowMapKeys(map: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of map) {
    if (ch === "{" || ch === "[") {
      depth++;
      if (depth === 1) token = "";
    } else if (ch === "}" || ch === "]") depth--;
    else if (depth === 1 && ch === ":") {
      if (unquote(token)) keys.push(unquote(token));
      token = "\u0000"; // until the next top-level comma, this is a value, not a key
    } else if (depth === 1 && ch === ",") token = "";
    else if (depth === 1 && !token.startsWith("\u0000")) token += ch;
  }
  return keys;
}

/** The events named in the top-level `on:` key: scalar, flow list, flow map or block mapping/list. */
export function workflowTriggers(text: string): string[] {
  const lines = stripComments(text).split("\n");
  const at = lines.findIndex((l) => ON_KEY.test(l));
  if (at < 0) return [];
  const inline = ON_KEY.exec(lines[at])![1].trim();
  if (inline.startsWith("{")) return flowMapKeys(inline);
  if (inline)
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter(Boolean);
  const events: string[] = [];
  let indent = -1;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    if (indent < 0) indent = lead;
    if (lead !== indent) continue;
    const m = /^\s*-?\s*['"]?([A-Za-z_]+)['"]?\s*:?/.exec(line);
    if (m) events.push(m[1]);
  }
  return events;
}

/** Ways a step brings pull-request code into a privileged run, each with what to call it. */
const PR_CODE_SHAPES: { re: RegExp; shape: string }[] = [
  {
    re: /allow-unsafe-pr-checkout:\s*['"]?true/,
    shape:
      "actions/checkout with allow-unsafe-pr-checkout: true (the named opt-out of checkout v7's refusal)",
  },
  {
    re: /^\s*ref:\s*.*github\.event\.pull_request\.head\.(?:sha|ref)/m,
    shape: "a checkout of the pull request's head",
  },
  { re: /^\s*ref:\s*.*github\.head_ref/m, shape: "a checkout of the pull request's head branch" },
  { re: /^\s*ref:\s*.*refs\/pull\//m, shape: "a checkout of refs/pull/…" },
  {
    re: /^\s*repository:\s*.*github\.event\.pull_request\.head\.repo/m,
    shape: "a checkout of the fork's repository",
  },
  {
    re: /^\s*ref:\s*.*github\.event\.workflow_run\.head_(?:sha|branch)/m,
    shape: "a checkout of the triggering run's head (workflow_run)",
  },
  {
    re: /^\s*repository:\s*.*github\.event\.workflow_run\.head_repository/m,
    shape: "a checkout of the triggering run's repository (workflow_run)",
  },
  {
    re: /\bgh\s+pr\s+checkout\b/,
    shape: "`gh pr checkout` in a run step (not covered by checkout v7)",
  },
  {
    re: /\bgit\s+(?:fetch|pull)\b[^\n]*\bpull\/[^\n]*\/(?:head|merge)\b/,
    shape: "`git fetch …pull/N/head` in a run step (not covered by checkout v7)",
  },
  {
    re: /\bgit\s+(?:checkout|switch|fetch)\b[^\n]*github\.event\.(?:pull_request\.head|workflow_run\.head)/,
    shape: "a git checkout of the pull request's head in a run step (not covered by checkout v7)",
  },
];

/**
 * An artifact from the run that triggered a `workflow_run`, followed by a `run:` step. When that
 * run was a pull request's, the artifact is PR-controlled ("artifacts from other workflows are
 * untrusted", GitHub Docs). kit cannot tell from the text whether the step only reads it as data,
 * so the message says what to check.
 */
const TRIGGERING_ARTIFACT =
  /\bactions\/download-artifact@[^\n]*(?:\n[^\n]*){0,6}?\n\s*run-id:\s*.*github\.event\.workflow_run\.id|\bdawidd6\/action-download-artifact@|\bgh\s+run\s+download\b[^\n]*github\.event\.workflow_run\.id/;
const RUN_STEP = /^\s*-?\s*run:/m;

function triggeringArtifactShape(triggers: string[], body: string): string | null {
  if (!triggers.includes("workflow_run")) return null;
  const m = TRIGGERING_ARTIFACT.exec(body);
  if (!m || !RUN_STEP.test(body.slice(m.index + m[0].length))) return null;
  return "an artifact from the triggering run, then a run step (workflow_run; make sure the artifact is only read as data, never executed)";
}

export interface PwnFinding {
  trigger: string;
  shapes: string[];
}

/** The privileged triggers of a workflow and the PR-code shapes it contains, or null when not both. */
export function pwnRequest(text: string): PwnFinding | null {
  const triggers = workflowTriggers(text).filter((t) => PRIVILEGED_TRIGGERS.includes(t));
  if (triggers.length === 0) return null;
  const body = stripComments(text);
  const shapes = PR_CODE_SHAPES.filter((s) => s.re.test(body)).map((s) => s.shape);
  const artifact = triggeringArtifactShape(triggers, body);
  if (artifact) shapes.push(artifact);
  return shapes.length ? { trigger: triggers.join(", "), shapes } : null;
}
