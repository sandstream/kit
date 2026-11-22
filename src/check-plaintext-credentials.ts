/**
 * Credentials that sit in plaintext in the home directory: the files an infostealer collects.
 *
 * kit's secret checks read the project (gitleaks, the env-write gate, `scan-plaintext.ts`). A token
 * that leaks from the machine never passes through them: stealers take browser stores and a short,
 * well-known list of files under the home directory, and what they take is sold before anyone looks
 * for it (kit-research `rivanorth-oko-dark-web-monitoring-vs-kit`). Finding a leaked API key
 * afterwards is not something a free source does, so this row shows the exposure beforehand: which
 * of those files hold a credential here, how long since each was written, and whether other
 * accounts on the machine can read it.
 *
 * Reads file names, sizes, modes, modification times, and whether a known marker is present. It
 * never prints, hashes or stores a value. No network. The list is the common tools, not every
 * tool: the row says how many files it looked for.
 */
import { closeSync, fstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { SecurityCheckResult } from "./check-security.js";

const NAME = "plaintext credentials in the home directory";
const DAY_MS = 86_400_000;
/** A credential not rewritten for this long has not been rotated for this long. */
const STALE_DAYS = 90;
const READ_LIMIT = 256 * 1024;

interface Candidate {
  /** Path under the home directory, in segments. */
  path: string[];
  what: string;
  /** Present when the file holds a credential; a config without one is not counted. */
  marker: RegExp;
}

const CANDIDATES: Candidate[] = [
  { path: [".aws", "credentials"], what: "AWS keys", marker: /aws_secret_access_key\s*=\s*\S/i },
  { path: [".npmrc"], what: "npm token", marker: /_authToken\s*=\s*\S|_password\s*=\s*\S/ },
  { path: [".netrc"], what: "netrc password", marker: /\bpassword\s+\S/ },
  { path: [".pgpass"], what: "Postgres password", marker: /^[^#\s][^:]*:[^:]*:[^:]*:[^:]*:\S/m },
  { path: [".pypirc"], what: "PyPI token", marker: /^\s*password\s*[=:]\s*\S/im },
  { path: [".git-credentials"], what: "git credentials", marker: /:\/\/[^\s:@/]+:[^\s@/]+@/ },
  { path: [".docker", "config.json"], what: "registry auth", marker: /"auth"\s*:\s*"[^"]+"/ },
  { path: [".config", "gh", "hosts.yml"], what: "GitHub token", marker: /oauth_token:\s*\S/ },
  {
    path: [".config", "gcloud", "application_default_credentials.json"],
    what: "Google credentials",
    marker: /"(refresh_token|private_key)"\s*:\s*"[^"]+"/,
  },
  {
    path: [".kube", "config"],
    what: "Kubernetes credentials",
    marker: /^\s*(token|client-key-data|password):\s*\S/m,
  },
  {
    path: [".terraform.d", "credentials.tfrc.json"],
    what: "Terraform token",
    marker: /"token"\s*:\s*"[^"]+"/,
  },
  {
    path: [".claude", ".credentials.json"],
    what: "Claude Code token",
    marker: /"(accessToken|refreshToken)"\s*:\s*"[^"]+"/,
  },
  {
    path: [".codex", "auth.json"],
    what: "Codex token",
    marker: /"(access_token|refresh_token|OPENAI_API_KEY)"\s*:\s*"[^"]+"/,
  },
  {
    path: [".kit", "mcp-tokens.json"],
    what: "kit MCP tokens",
    marker: /"accessToken"\s*:\s*"[^"]+"/,
  },
];

interface PlaintextCredential {
  shown: string;
  what: string;
  ageDays: number;
  /** POSIX only: group or other can read the file. */
  othersCanRead: boolean;
}

/** Size, mode, mtime and text through one descriptor; null when absent, too large or unreadable. */
function readSmall(path: string): { text: string; mtimeMs: number; mode: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > READ_LIMIT) return null;
    return { text: readFileSync(fd, "utf-8"), mtimeMs: st.mtimeMs, mode: st.mode };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** An OpenSSH private key stored without a passphrase: its cipher name is `none`. Pure. */
export function isUnencryptedPrivateKey(text: string): boolean {
  if (/-----BEGIN (RSA|EC|DSA) PRIVATE KEY-----/.test(text))
    return !/Proc-Type:\s*4,ENCRYPTED/.test(text);
  if (/-----BEGIN PRIVATE KEY-----/.test(text)) return true;
  const m = text.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]{1,400})/);
  if (!m) return false;
  const head = Buffer.from(m[1].replace(/\s+/g, "").slice(0, 80), "base64");
  // "openssh-key-v1\0", then a length-prefixed cipher name.
  if (head.subarray(0, 15).toString("latin1") !== "openssh-key-v1\0") return false;
  const len = head.readUInt32BE(15);
  return head.subarray(19, 19 + len).toString("latin1") === "none";
}

function sshKeys(home: string): { path: string[]; what: string }[] {
  try {
    return readdirSync(join(home, ".ssh"))
      .filter((n) => /^id_[a-z0-9_]+$/i.test(n))
      .sort()
      .slice(0, 20)
      .map((n) => ({ path: [".ssh", n], what: "SSH key without a passphrase" }));
  } catch {
    return [];
  }
}

/** The credential files present under `home`. Reads markers, never returns a value. */
export function findPlaintextCredentials(
  home: string,
  now: number,
  platform: string = process.platform,
): PlaintextCredential[] {
  const found: PlaintextCredential[] = [];
  const add = (path: string[], what: string, holds: (text: string) => boolean) => {
    const file = readSmall(join(home, ...path));
    if (file === null || !holds(file.text)) return;
    found.push({
      shown: `~/${path.join("/")}`,
      what,
      ageDays: Math.max(0, Math.floor((now - file.mtimeMs) / DAY_MS)),
      othersCanRead: platform !== "win32" && (file.mode & 0o044) !== 0,
    });
  };
  for (const c of CANDIDATES) add(c.path, c.what, (t) => c.marker.test(t));
  for (const k of sshKeys(home)) add(k.path, k.what, isUnencryptedPrivateKey);
  return found;
}

/** How many locations the row looks at, for its detail line. */
const LOOKED_FOR = CANDIDATES.length + 1;

function listed(items: PlaintextCredential[]): string {
  const one = (c: PlaintextCredential) =>
    `${c.shown} (${c.what}, written ${c.ageDays} d ago${c.othersCanRead ? ", readable by other accounts" : ""})`;
  const more = items.length > 8 ? ` and ${items.length - 8} more` : "";
  return items.slice(0, 8).map(one).join("; ") + more;
}

/** The verdict for a set of found files. Pure. */
export function judgePlaintextCredentials(found: PlaintextCredential[]): SecurityCheckResult[] {
  const base = { category: "exposure", name: NAME } as const;
  const scope = `${LOOKED_FOR} known locations checked, values never read out`;
  if (found.length === 0) {
    return [{ ...base, status: "pass", detail: `none found (${scope})` }];
  }
  const open = found.filter((c) => c.othersCanRead);
  const stale = found.filter((c) => c.ageDays >= STALE_DAYS);
  const detail = `${found.length} file(s) hold a credential in plaintext, which is what an infostealer collects: ${listed(found)} (${scope})`;
  if (open.length === 0 && stale.length === 0) return [{ ...base, status: "pass", detail }];
  const why = [
    open.length > 0 ? `${open.length} readable by other accounts (chmod 600)` : "",
    stale.length > 0 ? `${stale.length} not rewritten in ${STALE_DAYS} days or more (rotate)` : "",
  ].filter(Boolean);
  return [
    {
      ...base,
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail,
      suggestion: `${why.join("; ")}. Prefer short-lived logins (SSO, OIDC, a credential helper or \`kit secrets\`) over a long-lived token in a file`,
    },
  ];
}

/** The row for this machine. Never throws. */
export function checkPlaintextCredentials(
  home: string,
  now: number = Date.now(),
): SecurityCheckResult[] {
  try {
    return judgePlaintextCredentials(findPlaintextCredentials(home, now));
  } catch {
    return [];
  }
}
