### Security

- **`gate-bash` refuses the GitHub actions a scoped token reaches.** `gh pr merge --admin`, plain
  `gh pr merge`, `gh api -X PUT repos/…/pulls/N/merge`, a write to `…/pulls/N/ccr/auto_merge`,
  `gh secret set|delete`, `gh variable set`, `gh workflow run|enable|disable`, a workflow
  `dispatches` request, `gh auth token`, `gh auth refresh` and `gh auth login --with-token` all
  passed with exit 0, while the gate refused `git push origin main`. They now exit 2, also through
  `command gh`, an absolute path, a quoted `"gh"`, `sh -c`, `env`, `sudo`, `npx`, `$(…)` and
  PowerShell `-Command`, and the refusal names the action and asks the agent to hand it to the
  person. Reads (`gh api` GETs, `gh pr view|list`, `gh secret list`, `gh run view`) and
  `gh pr create` stay allowed. The carrier walk the nested-agent check used is now shared, in
  `src/gate-bash-carriers.ts`. Found by kit-research `agent-vm-yolo-herdr-paseo-vs-kit`.
