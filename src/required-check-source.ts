/**
 * Whether the default branch's required status checks are pinned to the app that reports them.
 *
 * GitHub matches a required check by its name. A rule that names no source accepts a check of that
 * name from any app or workflow that can write commit statuses, so a token with that permission can
 * post a green "build-and-test" for code that never ran it. Two sources recommend pinning the app:
 * Endor Labs after the November 2026 "wfx" campaign (kit-research `wfx-github-actions-campaign-vs-kit`),
 * and Anthropic's Claude Approvals docs, which warn that with "any source" GitHub accepts a
 * same-named check from elsewhere (kit-research `claude-ship-vs-kit`).
 *
 * The rule is the same whichever tool reports the check (a CI system, a review bot, Claude's or
 * Codex's apps), so nothing here names one.
 *
 * Pure: the caller fetches `GET /repos/{o}/{r}/rules/branches/{b}` (read access) and, when
 * readable, classic protection's `required_status_checks` (admin only).
 */
import type { SecurityCheckResult } from "./check-security.js";

const NAME = "default branch required check sources";

export interface RequiredCheck {
  context: string;
  /** The app id GitHub accepts the check from; null when any source is accepted. */
  appId: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function appIdOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Required checks from the active branch rules (`integration_id` is the pinned app). */
export function requiredChecksFromRules(rules: unknown): RequiredCheck[] {
  if (!Array.isArray(rules)) return [];
  const out: RequiredCheck[] = [];
  for (const rule of rules) {
    const r = record(rule);
    if (r?.type !== "required_status_checks") continue;
    const checks = record(r.parameters)?.required_status_checks;
    for (const c of Array.isArray(checks) ? checks : []) {
      const check = record(c);
      if (typeof check?.context !== "string" || !check.context) continue;
      out.push({ context: check.context, appId: appIdOf(check.integration_id) });
    }
  }
  return out;
}

/** Required checks from classic protection (`app_id` null or -1 means any source). */
export function requiredChecksFromClassic(protection: unknown): RequiredCheck[] {
  const checks = record(protection)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .map(record)
    .filter((c): c is Record<string, unknown> => typeof c?.context === "string" && !!c.context)
    .map((c) => ({ context: c.context as string, appId: appIdOf(c.app_id) }));
}

/**
 * One check counts as pinned when every rule that requires it names a source. A check pinned in a
 * ruleset but required "from any source" in classic protection is not pinned: GitHub applies both.
 */
export function requiredCheckSources(
  branch: string,
  checks: RequiredCheck[],
  classicRead: boolean,
): SecurityCheckResult {
  if (checks.length === 0) {
    return {
      category: "exposure",
      name: NAME,
      status: "pass",
      detail:
        `${branch}: no required status checks in the active rules` +
        (classicRead
          ? " or classic protection"
          : "; classic protection is not readable with this token"),
    };
  }
  const contexts = [...new Set(checks.map((c) => c.context))].sort();
  const unpinned = contexts.filter((ctx) =>
    checks.some((c) => c.context === ctx && c.appId === null),
  );
  const unread = classicRead
    ? ""
    : "; classic protection is not readable with this token (admin only)";
  if (unpinned.length === 0) {
    return {
      category: "exposure",
      name: NAME,
      status: "pass",
      detail: `${branch}: ${contexts.length} required check(s), each accepted only from the app that reports it${unread}`,
    };
  }
  const shown = unpinned
    .slice(0, 5)
    .map((c) => `"${c}"`)
    .join(", ");
  const more = unpinned.length > 5 ? ` and ${unpinned.length - 5} more` : "";
  return {
    category: "exposure",
    name: NAME,
    status: "warn",
    severity: "medium",
    detail:
      `${branch}: ${unpinned.length} of ${contexts.length} required check(s) accept a result from any source: ` +
      `${shown}${more}. Any token that can write commit statuses can post them as passed${unread}`,
    suggestion:
      "in the ruleset or branch protection, set each required check's source to the app that reports it (GitHub Actions, the CI system, or the review app)",
  };
}
