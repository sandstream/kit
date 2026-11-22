/**
 * A workflow step that takes every secret of the repository at once.
 *
 * `${{ toJSON(secrets) }}` expands to all secrets the job can read, as one JSON value. A step that
 * needs a secret names it (`secrets.NPM_TOKEN`); a step that takes all of them hands every
 * credential to whatever that step runs. The "wfx" campaign of November 2026 pushed exactly this
 * into existing workflows of thousands of repositories from stolen accounts: two added steps, one
 * with `toJSON(secrets)` and `toJSON(vars)` in its `env` (kit-research
 * `wfx-github-actions-campaign-vs-kit`, after Endor Labs, which recommends alerting on the
 * expression). kit's workflow audit had no row for it.
 *
 * Flagged: the expression anywhere outside a comment, one row per workflow with the lines it is
 * on. `toJSON(vars)` alone is not flagged: variables are not secret. Deterministic line scan, no
 * YAML dependency. It cannot tell a planted step from one the maintainers wrote; either way the
 * step holds every secret, so kit names it.
 */
import type { SecurityCheckResult } from "./check-security.js";

const SECRETS_DUMP_RULE = {
  id: "CWE-200",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/200.html",
  title: "Exposure of Sensitive Information to an Unauthorized Actor",
};

const DUMP = /\btoJSON\s*\(\s*secrets\s*\)/i;
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");

/** One row when a workflow expands every secret at once, naming the lines. */
export function auditSecretsDump(content: string, file: string): SecurityCheckResult[] {
  const lines = content
    .split(/\r?\n/)
    .map((line, i) => (DUMP.test(stripComment(line)) ? i + 1 : 0))
    .filter((n) => n > 0);
  if (lines.length === 0) return [];
  const where = lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(", ")}`;
  return [
    {
      category: "supply-chain",
      name: `workflow step takes every secret (${file})`,
      status: "warn",
      severity: "high",
      detail: `toJSON(secrets) on ${where}: the step receives every secret this job can read, not the ones it needs`,
      suggestion:
        "pass each secret the step needs by name; if nobody on the team added this step, treat the repository's secrets as stolen and rotate them",
      rule: SECRETS_DUMP_RULE,
    },
  ];
}
