### Security

- **Claude Code's PowerShell tool now reaches `kit gate-bash`.** kit wired the install gate with
  the matcher `Bash`, so a command Claude Code ran through its `PowerShell` tool (the primary shell
  on Windows, and the only one without Git Bash) was never gated: `npm install <untriaged>` or
  `irm … | iex` ran unchecked. The hook is now matched to `Bash|PowerShell`, as the Claude Code
  hooks reference advises for hooks that inspect shell commands. An existing `Bash`-only entry
  fails `enforcement gate liveness` in `kit check`, and `kit agent-config` (or the `kit hooks gates`
  SessionStart hook) widens it in place without adding a second gate entry. Not run on macOS or on
  Windows with a live Claude Code.
