/**
 * A `run:` step that sends a secret to a host outside GitHub.
 *
 * A step that needs a deploy token passes it to the service's own action, or to the GitHub API.
 * A step that puts `${{ secrets.NPM_TOKEN }}` on a `curl`, `wget`, `nc` or `socat` command line
 * with another host hands the credential to that host. kit-research
 * `agent-vm-yolo-herdr-paseo-vs-kit` measured that an agent can write such a workflow unhindered,
 * and kit's workflow audit then reported only the step's unpinned checkout.
 *
 * Flagged: a logical shell command (backslash and backtick continuations joined) in a `run:`
 * script that runs a network tool and carries a secret, where any host it names is not GitHub's.
 * A secret is `${{ secrets.X }}`, `${{ github.token }}`, or `$NAME` / `${NAME}` / `$env:NAME`
 * for an `env:` name the workflow sets from one of them (any `env:` in the file, so the scope is
 * wider than the step's). "Outside" is decided conservatively: only `github.com`,
 * `api.github.com`, `uploads.github.com` and the runner's `github.api_url` / `server_url` /
 * `graphql_url` (and their `GITHUB_*_URL` variables) count as inside, with GitHub's own package
 * hosts (`ghcr.io`, `*.pkg.github.com`) and the registry the workflow publishes to: a literal
 * host given as `registry-url:` / `registry:` / `repository-url:`, `--registry` /
 * `--repository-url`, or `docker login <host>`, counted only when the file also runs a publish
 * command (`npm publish`, `docker push`, `twine upload`, `cargo publish`, `push: true` and the
 * like). A host held in another variable, or a command with no visible host, counts as outside,
 * because kit cannot read it. Any other vendor that issued the token is reported too; the
 * suggestion says to use the vendor's action instead. Deterministic line scan, no YAML dependency.
 */
import type { SecurityCheckResult } from "./check-security.js";

const CREDENTIAL_HYGIENE_RULE = {
  id: "CICD-SEC-6",
  source: "owasp" as const,
  ref: "https://owasp.org/www-project-top-10-ci-cd-security-risks/CICD-SEC-06-Insufficient-Credential-Hygiene",
  title: "Insufficient Credential Hygiene",
};

const SECRET_EXPR = /\$\{\{\s*(secrets\.[A-Za-z0-9_-]+|github\.token)\s*\}\}/;
const ENV_LINE = /^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const NET_TOOL =
  /(?:^|[\s;|&(`])(curl|wget|nc|ncat|netcat|socat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?=\s|$)/i;
const GITHUB_URL_VAR =
  /\$\{\{\s*github\.(?:api_url|server_url|graphql_url)\s*\}\}|\$\{?GITHUB_(?:API|SERVER|GRAPHQL)_URL\b\}?|\$env:GITHUB_(?:API|SERVER|GRAPHQL)_URL\b/g;
const GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "uploads.github.com",
  "ghcr.io",
  "npm.pkg.github.com",
  "maven.pkg.github.com",
  "nuget.pkg.github.com",
  "rubygems.pkg.github.com",
]);
const PUBLISH =
  /\b(?:npm|pnpm|yarn)\s+(?:npm\s+)?publish\b|\bdocker\s+(?:image\s+)?push\b|\btwine\s+upload\b|\b(?:cargo|poetry|uv|flit|hatch)\s+publish\b|\bgem\s+push\b|\bnuget\s+push\b|\bmvn\b.*\bdeploy\b|^\s*push\s*:\s*true\b/m;
const REGISTRY_DECL =
  /(?:^\s*(?:-\s+)?(?:registry-url|registry|repository-url|repository_url)\s*:\s*|--(?:registry|repository-url)[=\s]+|\bdocker\s+login\s+(?:(?:-u|-p|--username|--password)(?:=|\s+)\S+\s+|--?[\w-]+(?:=\S+)?\s+)*)['"]?([^\s'"]+)/gm;
const UNREADABLE = "a host kit cannot read";

const indentOf = (line: string): number => line.length - line.trimStart().length;
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `env:`-style names whose value holds a secret expression (a test such as `!= ''` is not one). */
function secretEnvNames(lines: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of lines) {
    const m = ENV_LINE.exec(stripComment(line));
    if (!m || m[1] === "run") continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    const expr = SECRET_EXPR.exec(value);
    if (expr) names.set(m[1], expr[1]);
  }
  return names;
}

/** Every `run:` script line, with its 1-based line number, comments removed. */
function runLines(lines: string[]): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[2].trim();
    if (inline !== "" && !/^[|>][-+0-9]*\s*(#.*)?$/.test(inline)) {
      out.push({ n: i + 1, text: stripComment(inline) });
      continue;
    }
    const keyIndent = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "" && indentOf(lines[j]) <= keyIndent) break;
      out.push({ n: j + 1, text: stripComment(lines[j]) });
    }
  }
  return out;
}

/** Join shell (`\`) and PowerShell (`` ` ``) continuations into logical commands. */
function logicalCommands(
  script: Array<{ n: number; text: string }>,
): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let open: { n: number; text: string } | null = null;
  let prev = -1;
  for (const { n, text } of script) {
    if (open && n === prev + 1) open.text += ` ${text.trim()}`;
    else open = { n, text: text.trim() };
    prev = n;
    if (/[\\`]\s*$/.test(open.text)) open.text = open.text.replace(/[\\`]\s*$/, "");
    else {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

/** The secrets a command carries, by the name a reader recognises. */
function carriedSecrets(cmd: string, env: Map<string, string>): string[] {
  const found = [...cmd.matchAll(new RegExp(SECRET_EXPR.source, "g"))].map((m) => m[1]);
  for (const name of env.keys()) {
    const ref = new RegExp(`\\$\\{?${escapeRe(name)}\\b|\\$env:${escapeRe(name)}\\b`, "i");
    if (ref.test(cmd)) found.push(name);
  }
  return [...new Set(found)];
}

/** Hosts a network command names: URLs, `nc host port`, `socat TCP:host:port`. */
function hostsOf(cmd: string): string[] {
  const text = cmd.replace(GITHUB_URL_VAR, "https://api.github.com");
  const hosts = [...text.matchAll(/\bhttps?:\/\/([^/\s"'`?#\\]+)/gi)].map((m) =>
    m[1].replace(/:\d+$/, "").toLowerCase(),
  );
  const nc = /(?:^|[\s;|&(])(?:nc|ncat|netcat)\s+(.*)$/i.exec(text);
  if (nc) {
    const host = nc[1].split(/\s+/).find((t) => t !== "" && !t.startsWith("-") && !/^\d+$/.test(t));
    if (host) hosts.push(host.replace(/^['"]|['"]$/g, "").toLowerCase());
  }
  for (const m of text.matchAll(/\bTCP[46]?:([^:\s]+):/gi)) hosts.push(m[1].toLowerCase());
  return hosts;
}

/** Literal hosts of the registries a publishing workflow declares; none if it publishes nothing. */
function publishRegistries(content: string): Set<string> {
  const hosts = new Set<string>();
  if (!PUBLISH.test(content)) return hosts;
  for (const m of content.matchAll(REGISTRY_DECL)) {
    const host = m[1]
      .replace(/^[a-z]+:\/\//i, "")
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, "")
      .toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) hosts.add(host);
  }
  return hosts;
}

/** The outside destinations of one command: hosts not GitHub's, or the unreadable marker. */
function outsideHosts(cmd: string, inside: Set<string>): string[] {
  const hosts = hostsOf(cmd);
  if (hosts.length === 0) return [UNREADABLE];
  const outside = hosts
    .map((h) => (h.includes("$") ? UNREADABLE : h))
    .filter((h) => !GITHUB_HOSTS.has(h) && !inside.has(h));
  return [...new Set(outside)];
}

/** One row per workflow whose `run:` steps send a secret to a host outside GitHub. */
export function auditSecretEgress(content: string, file: string): SecurityCheckResult[] {
  const lines = content.split(/\r?\n/);
  const env = secretEnvNames(lines);
  const registries = publishRegistries(content);
  const sends: string[] = [];
  for (const { n, text } of logicalCommands(runLines(lines))) {
    if (!NET_TOOL.test(text)) continue;
    const secrets = carriedSecrets(text, env);
    if (secrets.length === 0) continue;
    const outside = outsideHosts(text, registries);
    if (outside.length > 0)
      sends.push(`line ${n} sends ${secrets.join(", ")} to ${outside.join(", ")}`);
  }
  if (sends.length === 0) return [];
  return [
    {
      category: "exposure",
      name: `secret sent to an outside host (${file})`,
      status: "warn",
      severity: "high",
      detail: `${sends.join("; ")}: whoever runs that host receives the credential`,
      suggestion:
        "send a secret only to the GitHub API or through the issuing service's own action pinned to a commit SHA; if nobody on the team wrote this step, treat the named secrets as stolen and rotate them",
      rule: CREDENTIAL_HYGIENE_RULE,
    },
  ];
}
