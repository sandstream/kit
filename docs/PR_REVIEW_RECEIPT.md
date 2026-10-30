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
Kit reads the rules from the current base commit and combines them with the proposed rules.
It also applies the default branch rules when the PR targets another branch.
If the base has no rule file, Kit uses the defaults built into the running Kit version.
Use a trusted Kit version to evaluate pull requests.
This keeps existing protections until the rule change is approved and merged.
Kit also checks the original names of renamed files.
Kit refuses the evidence if the base or head changes during collection, or if rules are unavailable.
The rule file itself always requires human approval.
Changes to those paths require a human approval before merge.
Receipts use version 2 and record the base and default branch commits.
Generate a new receipt after either branch changes.
Version 1 receipts remain valid only as signed failure history.

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
`kit escalate pr` reads these comments and checks the head, target branch, and merge base.
It reports missing, stale, malformed, and incomplete reports, as well as findings.
It also reports a comment when GitHub shows a different update time from its creation time.
Edited reports remain visible even for an older head. Kit cannot verify their earlier contents.
Kit cannot detect a deleted comment or a marker removed by editing.
It shows a reported pass without treating the comment as proof of independence or merge approval.
It asks for reviewer verification even when a comment reports pass. The command exits nonzero.
The command cannot yet record that verification.
The reviewer and author can share a GitHub identity. Later phases must verify identity and enforce merge rules.
An earlier finding on the same head remains visible even after a later pass.
Kit does not yet interpret written risk acceptance. A person must assess that acceptance.
