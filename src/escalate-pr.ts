/** Deterministic actions for a pull request that cannot yet proceed. */
import type { EscalationItem } from "./escalate.js";
import type { ProtectedClass } from "./review-protected-paths.js";
import type { ReviewCommentFinding, SelectedReviewComment } from "./review-comment.js";
import { redactSecrets } from "./utils/redactSecrets.js";

interface ReviewGateEvidence {
  command: string;
  exitCode: number;
  outputSha256: string;
  failures: string[];
}

export interface PrEscalationEvidence {
  repo: string;
  pr: number;
  head: string;
  receiptProblem: string | null;
  historyProblem?: string | null;
  gate: ReviewGateEvidence | null;
  lastFailedGate?: ReviewGateEvidence | null;
  failedGateRuns: number;
  checks: { name: string; status: string; conclusion: string; url: string }[];
  threads: {
    path: string;
    line: number | null;
    url: string;
    scenario: string;
    resolved: boolean;
  }[];
  protectedPaths: { path: string; classes: ProtectedClass[] }[];
  reviewComments?: SelectedReviewComment[];
  reviewCommentProblem?: string | null;
  humanApproved: boolean;
  mergeDenied: boolean;
}

function safeText(value: string): string {
  return redactSecrets(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function commentFindings(findings: ReviewCommentFinding[], url: string): EscalationItem[] {
  return findings.map((finding) => {
    const location = `${safeText(finding.file)}:${finding.line}`;
    return item(
      `independent finding ${location}`,
      `${safeText(finding.severity)}: ${location}: ${safeText(finding.scenario)}`,
      `Fix the finding or accept it in writing: ${url}`,
    );
  });
}

function commentReportItems(entry: SelectedReviewComment, head: string): EscalationItem[] {
  const { comment, result } = entry;
  const url = safeText(comment.url);
  const author = safeText(comment.author);
  const items: EscalationItem[] = [];
  if (comment.authorMissing) {
    items.push(
      item(
        "independent review author",
        "GitHub no longer identifies the author",
        `Inspect the report: ${url}`,
      ),
    );
  }
  if (result.kind !== "current") {
    items.push(
      item(
        `independent review by ${author}`,
        safeText(result.reason),
        `Inspect the report and request a current review: ${url}`,
      ),
    );
    if (result.report?.head === head) items.push(...commentFindings(result.report.findings, url));
    return items;
  }
  if (result.report.verdict === "incomplete") {
    items.push(
      item(
        `independent review by ${author}`,
        `Review incomplete: ${safeText(result.report.limits.join("; "))}`,
        `Complete the missing checks and record a new review: ${url}`,
      ),
    );
  }
  if (result.report.verdict === "pass") {
    items.push(
      item(
        `independent review by ${author}`,
        "Pass reported; reviewer independence is not verified",
        `Verify the reviewer and inspect the report: ${url}`,
      ),
    );
  }
  items.push(...commentFindings(result.report.findings, url));
  return items;
}

function reviewCommentItems(evidence: PrEscalationEvidence, prUrl: string): EscalationItem[] {
  if (evidence.reviewCommentProblem) {
    return [
      item(
        "independent review",
        safeText(evidence.reviewCommentProblem),
        `Inspect the PR comments and retry: kit escalate pr. ${prUrl}`,
      ),
    ];
  }
  if (!evidence.reviewComments || evidence.reviewComments.length === 0) {
    return [
      item(
        "independent review",
        "No independent review report was found for this pull request",
        "Run the independent-pr-review skill for the current head",
      ),
    ];
  }
  return evidence.reviewComments.flatMap((entry) => commentReportItems(entry, evidence.head));
}

function item(name: string, issue: string, action: string): EscalationItem {
  return { category: "pr", name, issue, action };
}

function receiptItems(evidence: PrEscalationEvidence, shortHead: string): EscalationItem[] {
  const items: EscalationItem[] = [];
  if (evidence.receiptProblem) {
    items.push(item("review receipt", evidence.receiptProblem, "Run: kit review --receipt"));
  }
  if (evidence.historyProblem) {
    items.push(
      item(
        "review history",
        evidence.historyProblem,
        "Inspect .kit-review-receipt-history.jsonl before merge",
      ),
    );
  }
  if (evidence.failedGateRuns >= 2) {
    const failed = evidence.lastFailedGate ?? (evidence.gate?.exitCode ? evidence.gate : null);
    const failing = failed?.failures[0] ?? "see the signed history for the failing check";
    const output = failed ? ` Output SHA-256: ${failed.outputSha256}` : "";
    const command = failed?.command ?? "kit review --receipt";
    items.push(
      item(
        "review gate",
        `Failed ${evidence.failedGateRuns} times on ${shortHead}: ${failing}.${output}`,
        `Rerun: ${command}. Inspect the signed failures and request human review. Kit cannot yet record risk acceptance.`,
      ),
    );
  }
  return items;
}

function checkItems(
  evidence: PrEscalationEvidence,
  shortHead: string,
  prUrl: string,
): EscalationItem[] {
  const items: EscalationItem[] = [];
  if (evidence.checks.length === 0) {
    items.push(
      item(
        "CI checks",
        "No checks are available for this PR head",
        `Wait for CI, then rerun: kit escalate pr. ${prUrl}`,
      ),
    );
  }
  for (const check of evidence.checks) {
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)) continue;
    const pending =
      check.conclusion === "" ||
      ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(check.status);
    items.push(
      item(
        `CI: ${check.name}`,
        pending
          ? `Check pending on ${shortHead}`
          : `Check ${check.conclusion.toLowerCase()} on ${shortHead}`,
        pending
          ? `Wait for the check, then rerun: kit escalate pr. ${check.url}`
          : `Inspect and rerun the check: ${check.url}`,
      ),
    );
  }
  return items;
}

function threadItems(evidence: PrEscalationEvidence): EscalationItem[] {
  return evidence.threads
    .filter((thread) => !thread.resolved)
    .map((thread) => {
      const location = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
      return item(
        `review finding ${location}`,
        `${location}: ${thread.scenario}`,
        `Fix the finding or accept it in writing: ${thread.url}`,
      );
    });
}

function protectedItems(
  evidence: PrEscalationEvidence,
  shortHead: string,
  prUrl: string,
): EscalationItem[] {
  if (evidence.humanApproved) return [];
  return evidence.protectedPaths.map((path) =>
    item(
      `protected path ${path.path}`,
      `${path.classes.join(", ")} change on ${shortHead}`,
      `A human must read the diff and approve this head: ${prUrl}/files`,
    ),
  );
}

export function collectPrEscalations(evidence: PrEscalationEvidence): EscalationItem[] {
  const shortHead = evidence.head.slice(0, 12);
  const prUrl = `https://github.com/${evidence.repo}/pull/${evidence.pr}`;
  return [
    ...receiptItems(evidence, shortHead),
    ...checkItems(evidence, shortHead, prUrl),
    ...threadItems(evidence),
    ...reviewCommentItems(evidence, prUrl),
    ...protectedItems(evidence, shortHead, prUrl),
    ...(evidence.mergeDenied
      ? [
          item(
            "merge permission",
            `Permission layer denied merge of PR #${evidence.pr} at ${shortHead}`,
            `After the review and checks pass, run: gh pr merge ${evidence.pr} --squash`,
          ),
        ]
      : []),
  ];
}
