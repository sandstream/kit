/**
 * Whether a default branch requires a review that the pull request's author cannot give.
 *
 * "Protected" alone says nothing about review. A branch can be protected, require a pull
 * request and still require 0 approvals. Then any identity with write access merges its own
 * pull request once checks pass, and an agent acting under the owner's account merges work
 * nobody reviewed. A merge that someone waved through without reading is not a review either,
 * so kit reports what the rules enforce, not what people are expected to do.
 *
 * Pure: the caller fetches the active rules and, when readable, classic protection.
 */
import type { SecurityCheckResult } from "./check-security.js";

const NAME = "default branch required reviews";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Required approvals from `GET /repos/{o}/{r}/rules/branches/{b}`, or null if no PR rule. */
export function approvalsFromRules(rules: unknown): number | null {
  if (!Array.isArray(rules)) return null;
  let best: number | null = null;
  for (const rule of rules) {
    const r = record(rule);
    if (r?.type !== "pull_request") continue;
    const n = count(record(r.parameters)?.required_approving_review_count) ?? 0;
    best = best === null ? n : Math.max(best, n);
  }
  return best;
}

/** Required approvals from classic protection's `required_pull_request_reviews`, if read. */
export function approvalsFromClassic(reviews: unknown): number | null {
  return count(record(reviews)?.required_approving_review_count);
}

export function reviewRequirement(
  branch: string,
  fromRules: number | null,
  fromClassic: number | null,
): SecurityCheckResult {
  const known = [fromRules, fromClassic].filter((n): n is number => n !== null);
  if (known.length === 0) {
    return {
      category: "exposure",
      name: NAME,
      status: "warn",
      detail:
        `unverified: ${branch} has no active ruleset that requires a pull request, and ` +
        "classic protection's review settings are not readable with this token (admin only)",
      didNotRun: true,
    };
  }
  const required = Math.max(...known);
  if (required === 0) {
    return {
      category: "exposure",
      name: NAME,
      status: "warn",
      severity: "medium",
      detail:
        `${branch}: 0 approvals required. Any identity with write access can merge its own ` +
        "pull request, including an agent acting under the owner's account",
      suggestion:
        "require at least 1 approval, and give agents an identity of their own (a reviewer " +
        "account or GitHub App), so the author's identity cannot approve its own work",
    };
  }
  return {
    category: "exposure",
    name: NAME,
    status: "pass",
    detail:
      `${branch}: ${required} approval(s) required. Bypass lists are not visible to a ` +
      "read token, so whether admins can skip the rule is not checked",
  };
}
