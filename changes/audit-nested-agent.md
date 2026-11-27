### Fixed

- **`kit agent-audit` counts a grant to start another coding agent as all three trifecta legs,
  and names it.** `Bash(claude --print --dangerously-skip-permissions:*)` and `Bash(claude:*)`
  passed with "no agent holds…", while `Bash(bash:*)` warned twice, although each starts an
  agent that runs code nobody approves. Such a grant now gets the write row, the lethal-trifecta
  row and a named row: "nested agent with approvals off" (high) when the grant carries a flag that
  turns the agent's approvals off, or "nested agent with arbitrary flags" (medium) when a wildcard
  lets any flag follow. The rule ledger gives Codex `prefix_rule(pattern=["codex", "exec",
  "--dangerously-bypass-approvals-and-sandbox"])` and Cursor `Shell(claude)` the same class and
  rows. The agents and flags come from `gate-bash`'s own table (`src/nested-agent-bypass.ts`); an
  exact command such as `Bash(claude --version)` stays narrow. Found by kit-research#236.
