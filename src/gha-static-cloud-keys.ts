/**
 * A long-lived cloud key in a workflow where the provider accepts GitHub's OIDC token instead.
 *
 * gha-id-token.ts reports the opposite direction: `id-token: write` granted where nothing uses it.
 * This is its pair: a static key used where OIDC would do (kit-research
 * `linkedin-batch-2026-11-27-vs-kit`). A stored key works from anywhere until someone rotates it,
 * and every later step and action in the job can read it. An OIDC token is minted per job and
 * expires within the hour.
 *
 * Flagged, per job:
 *   - AWS: `aws-actions/configure-aws-credentials` given `aws-access-key-id` /
 *     `aws-secret-access-key`, or an `env:` that sets `AWS_ACCESS_KEY_ID` /
 *     `AWS_SECRET_ACCESS_KEY` from `${{ secrets.* }}` (the workflow-level `env:` too);
 *   - GCP: `google-github-actions/auth` given `credentials_json`;
 *   - Azure: `azure/login` given `creds`.
 * The fix names the provider's OIDC inputs and `id-token: write` on that job only. Each provider's
 * OIDC guide is in `CLOUDS` below. Deterministic line scan, no YAML dependency, like the rest of
 * gha-audit.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { parseJobs } from "./gha-skip-gate.js";

const CREDENTIAL_HYGIENE_RULE = {
  id: "CICD-SEC-6",
  source: "owasp" as const,
  ref: "https://owasp.org/www-project-top-10-ci-cd-security-risks/CICD-SEC-06-Insufficient-Credential-Hygiene",
  title: "Insufficient Credential Hygiene",
};

interface Cloud {
  name: string;
  action: string;
  /** The action input that carries the static key. */
  keyInput: RegExp;
  /** The OIDC inputs to give the same action instead. */
  oidc: string;
  doc: string;
}

const CLOUDS: readonly Cloud[] = [
  {
    name: "AWS",
    action: "aws-actions/configure-aws-credentials",
    keyInput: /^(aws-access-key-id|aws-secret-access-key)\s*:\s*\S/,
    oidc: "`role-to-assume: <role ARN>`",
    doc: "https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services",
  },
  {
    name: "GCP",
    action: "google-github-actions/auth",
    keyInput: /^(credentials_json)\s*:\s*\S/,
    oidc: "`workload_identity_provider` (and `service_account` to impersonate one)",
    doc: "https://github.com/google-github-actions/auth#preferred-direct-workload-identity-federation",
  },
  {
    name: "Azure",
    action: "azure/login",
    keyInput: /^(creds)\s*:\s*\S/,
    oidc: "`client-id`, `tenant-id` and `subscription-id`, with no `creds`",
    doc: "https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect",
  },
];

const AWS = CLOUDS[0];

/** `AWS_ACCESS_KEY_ID: ${{ secrets.X }}` in an `env:` block (or as a list item). */
const AWS_ENV_SECRET =
  /^(?:-\s+)?(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*:\s*['"]?\$\{\{\s*secrets\./;

const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");
const codeLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => stripComment(l).trim())
    .filter((l) => l !== "");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a line calls `action` (any ref, any sub-path). */
const callsAction = (line: string, action: string): boolean =>
  new RegExp(`^(?:-\\s+)?uses\\s*:\\s*['"]?${escapeRe(action)}(/[^@\\s]*)?@`, "i").test(line);

/** The static-key inputs and env names a job's lines carry, per cloud. */
function staticKeys(lines: string[]): Map<Cloud, string[]> {
  const found = new Map<Cloud, string[]>();
  const add = (cloud: Cloud, what: string) => {
    const list = found.get(cloud) ?? [];
    if (!list.includes(what)) list.push(what);
    found.set(cloud, list);
  };
  for (const cloud of CLOUDS) {
    if (!lines.some((l) => callsAction(l, cloud.action))) continue;
    for (const l of lines) {
      const m = cloud.keyInput.exec(l);
      if (m) add(cloud, `${cloud.action} input ${m[1]}`);
    }
  }
  for (const l of lines) {
    const m = AWS_ENV_SECRET.exec(l);
    if (m) add(AWS, `env ${m[1]} from secrets`);
  }
  return found;
}

function suggestion(cloud: Cloud): string {
  return (
    `use OIDC: give ${cloud.action} ${cloud.oidc}, grant \`id-token: write\` on this job only ` +
    `(not at workflow level), trust only this repository and branch on the ${cloud.name} side, ` +
    `then delete the stored key. Guide: ${cloud.doc}`
  );
}

/** The lines above the top-level `jobs:` key: the workflow-level `env:` lives there. */
function preamble(content: string): string {
  const lines = content.split(/\r?\n/);
  const at = lines.findIndex((l) => /^jobs\s*:/.test(l));
  return (at < 0 ? lines : lines.slice(0, at)).join("\n");
}

/** One row per job and cloud that signs in with a stored key, plus one for a workflow-level env key. */
export function auditStaticCloudKeys(content: string, file: string): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  const top = staticKeys(codeLines(preamble(content))).get(AWS);
  if (top) {
    out.push({
      category: "supply-chain",
      name: `workflow-level static AWS key (${file})`,
      status: "warn",
      severity: "medium",
      detail:
        `the top-level env passes a long-lived AWS key (${top.join(", ")}) to every job and every ` +
        "action they run, where OIDC would give each job a short-lived token instead",
      suggestion: `move the key out of the top-level env, then ${suggestion(AWS)}`,
      rule: CREDENTIAL_HYGIENE_RULE,
    });
  }
  for (const job of parseJobs(content)) {
    for (const [cloud, keys] of staticKeys(codeLines(job.body))) {
      out.push({
        category: "supply-chain",
        name: `static ${cloud.name} key on job ${job.id} (${file})`,
        status: "warn",
        severity: "medium",
        detail:
          `job "${job.id}" signs in to ${cloud.name} with a long-lived key (${keys.join(", ")}) ` +
          "where OIDC would do: the key works from anywhere until it is rotated, and every later " +
          "step and action in the job can read it",
        suggestion: suggestion(cloud),
        rule: CREDENTIAL_HYGIENE_RULE,
      });
    }
  }
  return out;
}
