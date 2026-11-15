### Fixed

- **A new git worktree now gets the agent gates even when `.claude/` and `CLAUDE.md` are untracked.**
  The worktree mirror (the `post-checkout` hook) ran the Claude Code installers, which skip a checkout
  with neither file, so the worktree stayed ungated while the main checkout was gated. Git printed
  *"not wired here"*, but in a tool that starts every agent in a new worktree (Orca, Conductor) no one
  reads that line. The mirror now creates `.claude/` before it installs, except in read-only mode.
