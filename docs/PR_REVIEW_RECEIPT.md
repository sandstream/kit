# Pull request review receipt

Use `kit review --receipt` from a clean branch with an open GitHub pull request.
The command runs all five review stages with strict checks.
It writes `.kit-review-receipt.json` in the repository root.
The file records the PR head, the review command result, returned GitHub checks, review threads, and protected paths.
It stores hashes of review output and comment text.
It does not store the comment text.
The command reports missing checks, failed checks, and open review threads as evidence issues.
Failed local runs also enter `.kit-review-receipt-history.jsonl`.

Run `kit review verify-receipt` to check the signature and current PR head.
You can pass a receipt path after `verify-receipt`.
The signature uses the local audit anchor key in `~/.kit`.
Verification needs that key on the same machine.

The receipt records GitHub review threads only.
Other security findings need their own recorded source in a later review step.
This command does not approve or merge a pull request.
The protected path rules live in `.github/kit-protected-paths.json`.
Kit ships these rules for projects that do not have their own rule file.
Changes to those paths require a human approval before merge.

## Pull request escalation

Run `kit escalate pr` on a branch with an open GitHub pull request.
It reads the signed receipt and current GitHub checks and review threads.
It writes actions to `.kit-escalation.txt`.
The actions name repeated local gate failures, failed or pending CI, open findings, and protected paths.
The command reports every failed check. It does not decide whether Kit caused the failure.
The command checks approvals from another GitHub user for the exact PR head.
Use `kit escalate pr --merge-denied` after a permission layer refuses the merge.
That flag names the merge command in the handoff.
Approval given only outside GitHub is not visible to this command.
The `independent-pr-review` skill asks a separate reviewer to inspect the diff.
It records the verdict as a PR comment bound to the full head commit.
`kit escalate pr` does not read that comment. The reviewer and author can share a GitHub identity.
The comment does not prove independence. Later phases must verify the verdict and enforce merge rules.
