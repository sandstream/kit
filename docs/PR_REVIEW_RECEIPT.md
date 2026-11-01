# Pull request review receipt

Use `kit review --receipt` from a clean branch with an open GitHub pull request.
The command runs all five review stages with strict checks.
It writes `.kit-review-receipt.json` in the repository root.
The receipt, history, `.kit-audit.jsonl`, and `.kit-budget.json` files can be untracked without ignore rules.
These paths must be untracked regular files. Kit rejects symbolic links and hard links.
The worktree check does not verify the audit log or budget state, or establish their authenticity.
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
Review receipts require an owner-only key file owned by the current user.
Keep the key directory under trusted control during key creation and use.
The checks cannot prevent every concurrent replacement between file operations.
If Kit rejects an existing key, preserve that file and inspect its owner and permissions.
On POSIX systems, restrict the existing key file to mode `600` before retrying.
On Windows, restore an owner-only access control list on the existing key file.
Do not replace the key. Earlier signatures need the same key.

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
Read-only mode blocks receipt and history writes.
If read-only mode starts during a write, Kit preserves the remaining transaction evidence.
Inspect and recover that transaction after write access is restored.
Protected review key creation requires hard links on the key file system.
For review, Kit secures a temporary file before it writes key material.
Kit then links the completed key into place.
Other audit operations retain the earlier key creation behavior.
Those operations can write a new key before its permissions are restricted.
If read-only mode starts during key creation, Kit preserves any temporary key file.
A process interruption after linking can leave two names for the same key.
Kit refuses that key until a qualified person has inspected and resolved both names.
Preserve both names and confirm every key user has stopped before any manual action.
Only remove a temporary name after confirming it belongs to the interrupted creation.
The asynchronous receipt commands wait for the audit attempt before reporting a read-only refusal.
Synchronous internal file helpers start an audit attempt but cannot wait for it.
The audit record can be absent if the process stops before that attempt finishes.
An interrupted review blocks receipt verification and PR escalation until recovery.
Inspect the review process and confirm that it has stopped.
Run `kit review recover-receipt --confirm-stopped` to restore a known signed gate result.
Moving or renaming the worktree or its Git directory after an interruption can prevent recovery.
Preserve the worktree, Git metadata, lock, and signed pending evidence.
A qualified person must inspect the owner file and evidence before any manual action.
Do not edit or remove the lock to bypass the check.
Kit records the local gate result before it prints the report or requests PR evidence.
An interruption before that record leaves an unknown result and keeps the review locked.
An unknown result is not a confirmed gate failure.
Inspect the available output and decide whether to accept the remaining unknown risk.
To record that decision, run `kit review recover-receipt --confirm-stopped --acknowledge-unknown --interruption-review "describe the evidence and decision"`.
The signed local record includes the review identity, commit, decision, and note.
The signature protects the record against undetected changes.
The local signature does not prove the identity of the person who made the decision.
Use `kit review resolve-interruption RUN_ID --acknowledge-unknown --interruption-review "describe the evidence and decision"` for an older unresolved history entry.
Verification names each unresolved run and commit. It refuses to approve while one remains unresolved.
Keep evidence outside Kit if it is needed to establish the actual gate result.
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
Find the primary lock with `git rev-parse --git-path kit-review-receipt.lock`.
If its owner file is missing or damaged, preserve the complete lock directory first.
Confirm that no review or recovery process is running.
Have a qualified person inspect every file in the lock, including unknown files.
Inspect `generation`, `started`, `pending.json`, and staged `pending-*` files.
Also inspect the current receipt, history, and temporary receipt and history files in the worktree.
Preserve all files while the result is uncertain.
If the person confirms that no review result needs recovery, archive the complete lock directory.
Use a new unique name in the same Git metadata directory and do not replace any existing file.
Run a new review only after that inspection.
Recovery also reports temporary files left in the worktree by an interrupted write.
Preserve those files and the signed pending evidence before inspecting them.
Matching file identities alone do not prove that Kit owns a temporary name.
Kit does not bind the temporary name to the signed review identity.
It may be impossible to establish the origin from Kit evidence alone.
Keep both files if the origin cannot be established.
Only remove or move a temporary file after a qualified person confirms its ownership.
If history is incomplete or lacks a final newline, preserve its original bytes.
Have a qualified person verify and repair a separate copy.
Keep the original backup and place the verified copy at the original history path.
Then retry recovery.
History has a 16 MiB size limit.
If a new entry would exceed the limit, Kit preserves the history and pending evidence.
The review remains locked and requires expert inspection.
Kit does not provide automatic history rotation.
Do not delete history entries to bypass the limit.
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
