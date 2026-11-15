### Fixed

- **`kit check` reads Codex's user-level `hooks.json`** (`~/.codex/hooks.json`, or under `$CODEX_HOME`).
  Codex runs those hooks in every project, as Claude Code runs the hooks in `~/.claude/settings.json`,
  but only the Claude file was audited. Agent managers write here: Orca installs its Codex status hook
  in `~/.codex`. A malware-shaped command or a hook script now fails the agent-config audit the same
  way. Inline `[hooks]` tables in `config.toml` are not parsed yet.
