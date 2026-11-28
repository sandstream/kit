/**
 * Whether the git `user.email` this project commits with is a real-looking address.
 *
 * Every commit publishes its author address, and agents read `git log` and `git blame`, so the
 * address also lands in model context, where an agent can copy it into a request it writes
 * (kit-research `claude-code-account-email-user-agent-vs-kit`). A no-reply address such as
 * GitHub's `<id>+<login>@users.noreply.github.com` keeps commits attributed without either.
 *
 * Reads the effective value (`git config --get user.email` in the project: repo-local over
 * global). No network. The row never prints the address in full, only a masked form.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

/** Neutral on purpose: the row prints as `<name>: <status>`, so a claim here reads as the finding. */
const NAME = "git user.email no-reply";

/** Hosted no-reply domains: GitHub, GitLab, Codeberg, Bitbucket. */
const NOREPLY_DOMAIN =
  /^(users\.noreply\.github\.com|users\.noreply\.gitlab\.com|noreply\.codeberg\.org|noreply\.bitbucket\.org)$/;

/** True when an address is a hosted or otherwise obvious no-reply address. Pure. */
export function isNoReply(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  if (NOREPLY_DOMAIN.test(domain)) return true;
  if (/^no-?reply([+.-]|$)/.test(local)) return true;
  return /^no-?reply\./.test(domain);
}

/** First character, `***`, then `@domain`: enough to recognise, not enough to copy. Pure. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** The project's effective `user.email`; null outside a git work tree, "" when none is set. */
async function effectiveEmail(root: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const opts = { cwd: root, env, timeout: 10_000 };
  const inside = await execFileNoThrow("git", ["rev-parse", "--is-inside-work-tree"], opts);
  if (!inside.ok || inside.stdout.trim() !== "true") return null;
  const got = await execFileNoThrow("git", ["config", "--get", "user.email"], opts);
  return got.ok ? got.stdout.trim() : "";
}

/** One row on the address commits in `root` would carry; none outside a git work tree. */
export async function checkGitEmail(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecurityCheckResult[]> {
  const email = await effectiveEmail(root, env);
  if (email === null) return [];
  const row = { category: "exposure" as const, name: NAME };
  if (email === "") return [{ ...row, status: "skip", detail: "no git user.email is set" }];
  const masked = maskEmail(email);
  if (isNoReply(email)) return [{ ...row, status: "pass", detail: `${masked} (no-reply)` }];
  return [
    {
      ...row,
      status: "warn",
      severity: "low",
      detail: `not a no-reply address (${masked}): every commit publishes it, and agents read git log, so it lands in model context`,
      suggestion:
        "use your GitHub no-reply address (Settings > Emails): git config user.email <id>+<login>@users.noreply.github.com",
    },
  ];
}
