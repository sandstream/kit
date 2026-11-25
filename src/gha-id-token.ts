/**
 * `id-token: write` granted wider than it is used (GitHub Actions).
 *
 * `id-token: write` lets a job mint an OIDC token that cloud providers, Sigstore, npm and PyPI
 * accept as the repository's identity. Two shapes grant it to code that does not need it:
 *   - workflow level: a top-level `permissions:` with `id-token: write` (or `write-all`) gives the
 *     token to every job that does not set its own `permissions:`, including jobs added later;
 *   - a job that sets `id-token: write` but has no step that uses an OIDC token.
 *
 * "Uses" is an explicit list, `OIDC_USERS` below: a step that calls a known OIDC action, or a run
 * step with a command that asks for the token. A job that calls a reusable workflow, or a step that
 * runs a local action (`./…`), is not flagged: kit cannot see from this file whether it needs the
 * token. Deterministic line scan, no YAML dependency, like the rest of gha-audit.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { parseJobs } from "./gha-skip-gate.js";

const ID_TOKEN_RULE = {
  id: "CWE-250",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/250.html",
  title: "Execution with Unnecessary Privileges",
};

/** Actions that exchange the job's OIDC token. Matched on `uses: <owner>/<repo>[/path]@`. */
const OIDC_ACTIONS: readonly string[] = [
  "aws-actions/configure-aws-credentials", // AWS role assumption via OIDC
  "google-github-actions/auth", // GCP workload identity federation
  "azure/login", // Azure federated credentials
  "sigstore/cosign-installer", // cosign keyless signing in a later step
  "actions/attest-build-provenance", // GitHub artifact attestations (Sigstore)
  "actions/attest-sbom",
  "actions/attest",
  "pypa/gh-action-pypi-publish", // PyPI trusted publishing
  "ossf/scorecard-action", // publish_results signs with the OIDC identity
  "hashicorp/vault-action", // Vault JWT auth
];

/** Commands in a `run:` or script that ask for the OIDC token. */
const OIDC_COMMANDS: readonly { re: RegExp; what: string }[] = [
  { re: /\bnpm\s+publish\b/, what: "npm publish (trusted publishing / --provenance)" },
  { re: /\bNPM_CONFIG_PROVENANCE\b/i, what: "npm provenance" },
  { re: /\bcosign\s+(sign|attest)\b/, what: "cosign keyless sign/attest" },
  { re: /\bACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)\b/, what: "a direct OIDC token request" },
  { re: /\bgetIDToken\s*\(/, what: "core.getIDToken()" },
];

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("#");
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");

/** Whether the `permissions:` key at `indent` in `lines` grants `id-token: write`. */
export function grantsIdToken(lines: string[], indent: number): boolean {
  const at = lines.findIndex(
    (l) => indentOf(l) === indent && /^permissions\s*:/.test(l.trimStart()),
  );
  if (at < 0) return false;
  const inline = stripComment(lines[at])
    .trim()
    .replace(/^permissions\s*:/, "")
    .trim();
  if (/^['"]?write-all['"]?$/.test(inline)) return true;
  if (inline !== "") return /\bid-token\s*:\s*['"]?write\b/.test(inline);
  for (const line of lines.slice(at + 1)) {
    if (!isContent(line)) continue;
    if (indentOf(line) <= indent) break;
    if (/^id-token\s*:\s*['"]?write['"]?$/.test(stripComment(line).trim())) return true;
  }
  return false;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What in a job uses the OIDC token: "unknown" when kit cannot see, else the users found. */
export function oidcUsers(jobLines: string[]): string[] | "unknown" {
  const code = jobLines.filter(isContent).map(stripComment);
  const keyIndent = indentOf(code.find((l) => l.trim() !== "") ?? "");
  const reusable = code.some((l) => indentOf(l) === keyIndent && /^uses\s*:/.test(l.trim()));
  if (reusable || code.some((l) => /\buses\s*:\s*['"]?\.\//.test(l))) return "unknown";
  const text = code.join("\n");
  const found = OIDC_ACTIONS.filter((a) =>
    new RegExp(`\\buses\\s*:\\s*['"]?${escapeRe(a)}(/[^@\\s]*)?@`, "i").test(text),
  );
  for (const c of OIDC_COMMANDS) if (c.re.test(text)) found.push(c.what);
  return found;
}

/**
 * Third-party actions a job's steps call: not GitHub's own (`actions/*`, `github/*`), not local.
 * kit does not read their code, so it cannot say they leave the OIDC token alone.
 */
function unreadActions(jobLines: string[]): string[] {
  const text = jobLines.filter(isContent).map(stripComment).join("\n");
  const refs = [...text.matchAll(/\buses\s*:\s*['"]?([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@/g)];
  const third = refs.map((m) => m[1]).filter((a) => !/^(actions|github)\//i.test(a));
  return [...new Set(third)];
}

function unusedDetail(jobId: string, unread: string[]): string {
  const known = "none of the known OIDC actions or commands appear";
  if (unread.length === 0)
    return `job "${jobId}" grants id-token: write but no step uses an OIDC token (${known})`;
  return (
    `job "${jobId}" grants id-token: write and no step kit can read uses an OIDC token (${known}); ` +
    `kit did not read the third-party action(s) ${unread.join(", ")}, which may use it`
  );
}

/** Flag `id-token: write` at workflow level, and on a job that never uses it. Pure. */
export function auditIdToken(content: string, file: string): SecurityCheckResult[] {
  const lines = content.split(/\r?\n/);
  const out: SecurityCheckResult[] = [];
  if (grantsIdToken(lines, 0)) {
    out.push({
      category: "supply-chain",
      name: `workflow-level id-token: write (${file})`,
      status: "warn",
      severity: "medium",
      detail:
        "the top-level permissions grant id-token: write, so every job without its own permissions " +
        "block can mint an OIDC token that cloud, registry and signing services accept as this repository",
      suggestion:
        "set the top-level permissions to read (or {}) and grant id-token: write only on the job that signs, publishes or logs in",
      rule: ID_TOKEN_RULE,
    });
  }
  for (const job of parseJobs(content)) {
    const body = job.body.split("\n");
    const keyIndent = indentOf(body.find(isContent) ?? "");
    if (!grantsIdToken(body, keyIndent)) continue;
    const users = oidcUsers(body);
    if (users === "unknown" || users.length > 0) continue;
    out.push({
      category: "supply-chain",
      name: `unused id-token: write on job ${job.id} (${file})`,
      status: "warn",
      severity: "low",
      detail: unusedDetail(job.id, unreadActions(body)),
      suggestion:
        "remove id-token: write from this job; if a step does need it, check that the step is one kit knows (src/gha-id-token.ts)",
      rule: ID_TOKEN_RULE,
    });
  }
  return out;
}
