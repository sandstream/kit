### Fixed

- **`kit check` reads a project's `.codex/hooks.json`.** `.codex/config.toml` was audited, but not the
  hooks file beside it, which Codex runs on every matching event once the project's `.codex/` layer is
  trusted. A malware-shaped command or hook script there now fails the agent-config audit, as one in
  `.claude/settings.json` does.
