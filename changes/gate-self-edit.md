### Fixed

- `gate-env` and `gate-bash` now refuse an agent's Write, Edit or shell command that removes or replaces kit's `gate-bash`/`gate-env` entries in `.claude/settings.json`, `.claude/settings.local.json` or `~/.claude/settings.json`, or leaves that file unparseable. Adding another tool's hooks stays allowed, and `kit agent-config` still rewrites them.
