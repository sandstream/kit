### Added

- **`kit agent-config --user` gates every checkout on the machine.** It writes the Claude Code PreToolUse gates (`gate-bash`, `gate-env`) into the user-level `~/.claude/settings.json`, which Claude Code applies in every project, so a fresh clone or a new worktree is gated before anyone runs `kit agent-config` in it. It merges into the existing file without dropping a key, copies the file as it was to `settings.json.bak`, and refuses a file that is not valid JSON instead of replacing it. The `kit check` row `enforcement gate liveness` now counts a gate in the user file as wired.
