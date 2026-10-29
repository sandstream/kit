# Pull request review receipt

Use `kit review --receipt` from a clean branch with an open GitHub pull request.
The command runs all five review stages with strict checks.
It writes `.kit-review-receipt.json` in the repository root.
The file records the PR head, the review command result, returned GitHub checks, review threads, and protected paths.
It stores hashes of review output and comment text.
It does not store the comment text.
The command reports missing checks, failed checks, and open review threads as evidence issues.

Run `kit review verify-receipt` to check the signature and current PR head.
You can pass a receipt path after `verify-receipt`.
The signature uses the local audit anchor key in `~/.kit`.
Verification needs that key on the same machine.

The receipt records GitHub review threads only.
Other security findings need their own recorded source in a later review step.
This command does not approve or merge a pull request.
The protected path rules live in `.github/kit-protected-paths.json`.
Changes to those paths require a human approval before merge.
