/** Deterministic actions for a pull request that cannot yet proceed. */
import type { EscalationItem } from "./escalate.js";
import type { ProtectedClass } from "./review-protected-paths.js";

export interface PrEscalationEvidence {
  repo: string;
  pr: number;
  head: string;
  receiptProblem: string | null;
  historyProblem?: string | null;
  gate: {
    command: string;
    exitCode: number;
    outputSha256: string;
    failures: string[];
  } | null;
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
  humanApproved: boolean;
  mergeDenied: boolean;
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
  if (
    evidence.gate?.exitCode !== undefined &&
    evidence.gate.exitCode !== 0 &&
    evidence.failedGateRuns >= 2
  ) {
    const failing = evidence.gate.failures[0] ?? "see the review output for the failing check";
    items.push(
      item(
        "review gate",
        `Failed ${evidence.failedGateRuns} times on ${shortHead}: ${failing}. Output SHA-256: ${evidence.gate.outputSha256}`,
        `Rerun: ${evidence.gate.command}. Inspect the failing check before retrying the merge.`,
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
