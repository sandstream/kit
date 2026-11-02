# Agent review gate

How a pull request on this repository gets the one approval `main` requires, without the owner
clicking "approve" on work nobody read.

## Who approves

The reviewer GitHub App, `sandstream-kit-reviewer[bot]`, approves. It is a separate identity from
anyone who writes code here, the owner and coding agents included, and GitHub does not let an
author approve their own pull request. So "approved" means a second identity signed off.

## What it checks

`.github/workflows/agent-review-gate.yml` runs `scripts/agent-review-gate.mjs` each time a
pull-request workflow finishes. Once every check on the head commit has finished, the App
**approves that exact commit** only when all of these hold:

- every check passed (`success`, `skipped` or `neutral`; a re-run counts by its newest result);
- no changed file, including a rename's old path, is in a protected class of
  `.github/kit-protected-paths.json` (release, `.github/`, secrets, permissions). The rules come
  from the default branch, never from the pull request;
- the file list is complete, and the change is under 1,500 lines.

Otherwise it comments once with the reason and approves nothing.

## What an approval does not claim

The gate is deterministic: it has no model and does not judge what the change is for. Its
approval says so. A pull request that touches a protected class always needs the owner.

## Safety

- The workflow runs on `workflow_run`, from the default branch, and checks out the default branch
  only. Pull-request code never runs in it, so a pull request cannot change the gate or reach the
  App's key.
- Reads use the workflow's read-only token. Only the review is posted with the App's token, which
  `scripts/github-app-token.mjs` narrows to this repository with `pull_requests: write` and
  `contents: read`.
- Any failure to read or decide throws and approves nothing.

## Setup it depends on

- The App is installed on this repository.
- Actions variable `REVIEWER_APP_ID` and Actions secret `REVIEWER_APP_PRIVATE_KEY` are set.
- The `main` ruleset requires 1 approval, with approval of the most recent push.

`Reviewer identity probe` (manual workflow) posts a COMMENT review as the App, to check the
identity and token without approving anything.
