/**
 * Install-time scripts that run with a job's credentials (GitHub Actions).
 *
 * `npm ci`, `npm install` and `npm i` run lifecycle scripts: npm 10 and 11 run every one, and
 * npm 12 skips only the dependencies' scripts, never the project's own `preinstall`, `install`,
 * `postinstall` or `prepare`. The wfx-loot campaign (2026-11) added a `postinstall` to a
 * repository's own package.json; the repository's trusted workflow ran it at `npm ci`, with the
 * job's secrets in its environment.
 *
 * This rule flags such an install, in a `run:` step without `--ignore-scripts`, in a job that holds
 * a credential: the job references `${{ secrets.* }}` (env, with or run; `secrets.GITHUB_TOKEN`
 * counts), the workflow-level `env:` does, or the job can mint an OIDC token (`id-token: write` or
 * `write-all` on the job, or on the workflow when the job sets no `permissions:` of its own).
 *
 * npm only: the rest of gha-audit models no other package manager. Deterministic line scan, no
 * YAML dependency, like the rest of gha-audit.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { parseJobs, type WorkflowJob } from "./gha-skip-gate.js";

const INSTALL_SCRIPTS_RULE = {
  id: "CWE-829",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/829.html",
  title: "Inclusion of Functionality from Untrusted Control Sphere",
};

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("#");
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");
const SECRET_REF = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g;
const NPM_INSTALL = /\bnpm\s+(ci|install|i)\b/;
const IGNORES_SCRIPTS = /--ignore-scripts(?!=false)\b/;

/** The lines of the key `key:` at `indent` (the key line and everything nested under it). */
function keyBlock(lines: string[], indent: number, key: string): string[] | null {
  const re = new RegExp(`^${key}\\s*:`);
  const at = lines.findIndex((l) => indentOf(l) === indent && re.test(l.trimStart()));
  if (at < 0) return null;
  const end = lines.findIndex((l, n) => n > at && isContent(l) && indentOf(l) <= indent);
  return lines.slice(at, end < 0 ? undefined : end);
}

/** Whether a `permissions:` block (from keyBlock) grants `id-token: write`. */
function grantsIdTokenWrite(block: string[] | null): boolean {
  if (!block) return false;
  const text = block.map(stripComment).join("\n");
  return (
    /^\s*permissions\s*:\s*[\x27\x22]?write-all\b/.test(text) ||
    /\bid-token\s*:\s*[\x27\x22]?write\b/.test(text)
  );
}

/** The `secrets.*` names a block of lines references, comments excluded. */
function secretNames(lines: string[]): string[] {
  const text = lines.filter(isContent).map(stripComment).join("\n");
  return [...new Set([...text.matchAll(SECRET_REF)].map((m) => m[1]))];
}

/** What the workflow's top level hands every job: id-token (unless overridden) and env secrets. */
export interface WorkflowCredentials {
  idToken: boolean;
  envSecrets: string[];
}

function workflowCredentials(lines: string[]): WorkflowCredentials {
  return {
    idToken: grantsIdTokenWrite(keyBlock(lines, 0, "permissions")),
    envSecrets: secretNames(keyBlock(lines, 0, "env") ?? []),
  };
}

/** The credentials one job holds, in words, or [] when it holds none kit can see. */
function jobCredentials(job: WorkflowJob, top: WorkflowCredentials): string[] {
  const body = job.body.split("\n");
  const keyIndent = indentOf(body.find(isContent) ?? "");
  const own = keyBlock(body, keyIndent, "permissions");
  const held: string[] = [];
  const secrets = [...new Set([...top.envSecrets, ...secretNames(body)])];
  if (secrets.length > 0) held.push(`secrets ${secrets.join(", ")}`);
  if (grantsIdTokenWrite(own)) held.push("id-token: write");
  else if (own === null && top.idToken) held.push("id-token: write (inherited from the workflow)");
  return held;
}

/** `run:` commands in a job, as [offset in body, command line]. Joins `\` continuations. */
export function runCommands(body: string[]): [number, string][] {
  const out: [number, string][] = [];
  for (let n = 0; n < body.length; n++) {
    const key = /^(\s*)(-\s+)?run\s*:\s*(.*)$/.exec(stripComment(body[n]));
    if (!key) continue;
    const keyIndent = key[1].length + (key[2]?.length ?? 0);
    const inline = key[3].trim();
    if (inline !== "" && !/^[|>][-+]?$/.test(inline)) {
      out.push([n, inline]);
      continue;
    }
    for (let m = n + 1; m < body.length; m++) {
      if (isContent(body[m]) && indentOf(body[m]) <= keyIndent) break;
      if (isContent(body[m])) out.push([m, stripComment(body[m]).trim()]);
    }
  }
  return joinContinuations(out);
}

function joinContinuations(cmds: [number, string][]): [number, string][] {
  const out: [number, string][] = [];
  let open = false;
  for (const [n, text] of cmds) {
    const last = out.at(-1);
    if (open && last) last[1] = `${last[1].replace(/\\$/, "")} ${text}`;
    else out.push([n, text]);
    open = text.endsWith("\\");
  }
  return out;
}

/** The npm installs in a job's run steps that do not pass --ignore-scripts. */
export function scriptedInstalls(body: string[]): [number, string][] {
  return runCommands(body).filter(([, cmd]) => NPM_INSTALL.test(cmd) && !IGNORES_SCRIPTS.test(cmd));
}

/** `text` as a literal inside a RegExp: every metacharacter, the backslash included, escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

/** Line index (0-based) of each job's header in the workflow, in job order. */
function jobHeaders(lines: string[], jobs: WorkflowJob[]): number[] {
  let from = lines.findIndex((l) => /^jobs\s*:/.test(l));
  return jobs.map((j) => {
    const re = new RegExp(`^\\s+${escapeRegExp(j.id)}\\s*:\\s*(#.*)?$`);
    from = lines.findIndex((l, n) => n > from && re.test(l));
    return from;
  });
}

/** Flag npm installs without --ignore-scripts in jobs that hold a credential. Pure. */
export function auditInstallScripts(content: string, file: string): SecurityCheckResult[] {
  const lines = content.split(/\r?\n/);
  const top = workflowCredentials(lines);
  const jobs = parseJobs(content);
  const headers = jobHeaders(lines, jobs);
  const out: SecurityCheckResult[] = [];
  jobs.forEach((job, j) => {
    const held = jobCredentials(job, top);
    if (held.length === 0) return;
    for (const [offset, cmd] of scriptedInstalls(job.body.split("\n"))) {
      out.push(finding(job.id, `${file}:${headers[j] + 2 + offset}`, cmd, held));
    }
  });
  return out;
}

function finding(job: string, where: string, cmd: string, held: string[]): SecurityCheckResult {
  const install = NPM_INSTALL.exec(cmd)?.[0] ?? "npm install";
  return {
    category: "supply-chain",
    name: `install scripts run with credentials: job ${job} (${where})`,
    status: "warn",
    severity: "high",
    detail:
      `job "${job}" holds ${held.join("; ")} and runs \`${install}\` without --ignore-scripts: ` +
      `npm runs the project's own preinstall/install/postinstall/prepare (npm 10 and 11 also every ` +
      `dependency's), so a changed package.json runs code with those credentials (wfx-loot, 2026-11)`,
    suggestion:
      `add --ignore-scripts to \`${install}\` (run any build step the project needs as its own ` +
      `step), or move the install into a job that holds no secrets and no id-token: write`,
    rule: INSTALL_SCRIPTS_RULE,
  };
}
