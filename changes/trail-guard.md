### Added

- **The gates keep an agent's tool calls away from kit's own trail.** kit-research
  `agent-swarms-security-guide-vs-kit` measured that an agent running as the same user could delete
  `.kit-audit.jsonl`, write one row and run `kit audit anchor`, after which `kit audit verify`
  exited 0, with no gate refusing any step. `kit gate-bash` now refuses a command that changes or
  deletes `.kit-audit.jsonl`, `.kit-approvals.jsonl` or `~/.kit/`, any command that names the
  audit anchor key or record, and `kit audit anchor` or `kit panic`. `kit gate-env` refuses a
  Write/Edit to those files. Reading the log and running the `~/.kit/bin/kit` wrapper stay
  allowed; a person runs the refused commands themselves. A script the agent wrote earlier is
  not covered; external anchoring is that boundary.
