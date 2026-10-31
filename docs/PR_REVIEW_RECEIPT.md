# Pull request review receipt

Use `kit review --receipt` from a clean branch with an open GitHub pull request.
The command runs all five review stages with strict checks.
It writes `.kit-review-receipt.json` in the repository root.
The receipt and history files can be untracked without entries in `.gitignore`.
Both paths must be untracked regular files. Kit rejects symbolic links and hard links.
Kit requires a usable file identity to open the files.
Kit rejects the operation if it cannot verify that identity.
Keep the worktree and its parent directories under trusted control during the operation.
The file records the PR head, the review command result, returned GitHub checks, review threads, and protected paths.
It stores hashes of review output and comment text.
It does not store the comment text.
The command reports missing checks, failed checks, and open review threads as evidence issues.
Failed local runs also enter `.kit-review-receipt-history.jsonl`.
The file system must support hard links to create a new history file.
Kit stops if the file system cannot create the link.
Kit checks the worktree and PR identity before the review and before it signs the receipt.
The checks cannot detect a file that changes and returns to its original state during the review.
Git status also excludes ignored files from the worktree check.
Run the review in a worktree that no other process changes.

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
New receipts use version 3 and record a unique review run identity.
They record the base and default branch commits.
Generate a new receipt after either branch changes.
Version 2 receipts remain valid as current receipts.
Version 1 receipts remain valid only as signed failure history.

Kit permits one receipt review at a time in each Git worktree.
The lock stays in the worktree's Git metadata until the signed receipt and history are complete.
An interrupted review blocks receipt verification and PR escalation until recovery.
Inspect the review process and confirm that it has stopped.
Run `kit review recover-receipt --confirm-stopped` to restore the signed pending result.
Recovery records an interrupted review as incomplete, not as a confirmed gate failure.
Run a new review after recovery reports an interruption or changed pull request.
Kit does not automatically remove locks based on age or an absent process ID.
If a recovery claim is also left behind, inspect its owner and confirm that process has stopped.
Find the claim owner with `git rev-parse --git-path kit-review-receipt.lock/recovery/owner.json`.
Read the named file and confirm that its host and process have stopped.
Remove that owner file and its empty parent directory only after that inspection.
Run the recovery command again.
If staged evidence is incomplete or invalid, Kit leaves the review locked.
Inspect the files in the lock directory before removing an invalid staged file.
Run the recovery command again after that inspection.
This recovery flow covers process interruption. It does not guarantee recovery after power loss.
Signatures reveal changes to retained history entries.
They do not prove that earlier entries or the whole history file still exist.

## Pull request escalation

Run `kit escalate pr` on a branch with an open GitHub pull request.
It reads the signed receipt and current GitHub checks and review threads.
It writes actions to `.kit-escalation.txt`.
The actions name repeated local gate failures, failed or pending CI, open findings, and protected paths.
Two failed gate runs on one head still require human review after a later passing run.
Kit cannot yet record acceptance of that risk.
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
