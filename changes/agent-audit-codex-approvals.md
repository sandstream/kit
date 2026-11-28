### Added

- **`kit agent-audit` names Codex config with its approvals or sandbox off.** Claude Code's
  `defaultMode: "bypassPermissions"` gave "write access without confirmation: main session", while a
  Codex config with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` gave no
  row. Both together (or with `default_permissions = ":danger-full-access"`) now give the same
  medium warning; one alone gives a low "approvals off" or "sandbox off" warning. kit reads
  `$CODEX_HOME/config.toml` (default `~/.codex`), its `<name>.config.toml` profile files, legacy
  `[profiles.<name>]` tables, and the project `.codex/config.toml`. Keys verified against
  developers.openai.com/codex/config-reference (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`).
