### Added

- `kit check` and `kit agent-audit` record a sha256 per user-level agent file (`~/.claude/skills`, `commands`, `agents`, `rules`, `~/.claude/CLAUDE.md`, Codex's `AGENTS.md` and skills) in `~/.kit/user-surfaces.json`, and warn on every run while a file is added, changed or removed relative to that baseline. `kit agent-audit --accept-user-surfaces` accepts the current files. The first run records the baseline; read-only mode writes none.
