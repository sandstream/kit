### Fixed

- **kit's own repository now wires its PreToolUse gates in the committed `.claude/settings.json`.** The file held only the SessionStart hook, so a fresh clone or a cloud session of kit ran with no `gate-bash` or `gate-env`. The hooks invoke `kit` from PATH, with no machine-specific path, and a test asserts both are wired.
