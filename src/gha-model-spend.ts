/**
 * Workflow-wide permissions that let a job call a model on the organisation's account.
 *
 * `copilot-requests: write` lets the workflow's built-in token authenticate GitHub Copilot, billed
 * with the organisation's Copilot spend (kit-research `owasp-xpsd-vs-kit`: the OWASP Xpsd action
 * asks for it). `models: read` does the same for GitHub Models inference. Neither reaches code or
 * secrets, but a job that holds one can spend budget, and can send whatever it reads to a model.
 *
 * Flagged, like `id-token: write` in gha-id-token.ts: the grant at workflow level, where every
 * job without its own `permissions:` gets it, including jobs added later. `write-all` is left to
 * the id-token rule, which already reports it. A grant on one job is the intended shape and is
 * not reported. Deterministic line scan, no YAML dependency.
 */
import type { SecurityCheckResult } from "./check-security.js";

const MODEL_SPEND_RULE = {
  id: "CWE-250",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/250.html",
  title: "Execution with Unnecessary Privileges",
};

const GRANTS: readonly { re: RegExp; grant: string; what: string }[] = [
  {
    re: /\bcopilot-requests\s*:\s*['"]?write\b/,
    grant: "copilot-requests: write",
    what: "call GitHub Copilot on the organisation's Copilot spend",
  },
  {
    re: /\bmodels\s*:\s*['"]?(read|write)\b/,
    grant: "models: read",
    what: "call GitHub Models on the organisation's account",
  },
];

const indentOf = (line: string): number => line.length - line.trimStart().length;
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");

/** The text of the top-level `permissions:` block (inline or indented), or "" when there is none. */
export function topLevelPermissions(content: string): string {
  const lines = content.split(/\r?\n/).map(stripComment);
  const at = lines.findIndex((l) => indentOf(l) === 0 && /^permissions\s*:/.test(l));
  if (at < 0) return "";
  const block = [lines[at].replace(/^permissions\s*:/, "")];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (indentOf(line) === 0) break;
    block.push(line);
  }
  return block.join("\n");
}

/** One row per model-spend permission granted to the whole workflow. */
export function auditModelSpend(content: string, file: string): SecurityCheckResult[] {
  const block = topLevelPermissions(content);
  return GRANTS.filter((g) => g.re.test(block)).map((g) => ({
    category: "supply-chain" as const,
    name: `workflow-level ${g.grant} (${file})`,
    status: "warn" as const,
    severity: "low" as const,
    detail: `the top-level permissions grant ${g.grant}, so every job without its own permissions block can ${g.what}, and can send what it reads to a model`,
    suggestion: `grant ${g.grant} only on the job that calls the model, and keep the top-level permissions to what every job needs`,
    rule: MODEL_SPEND_RULE,
  }));
}
