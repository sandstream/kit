### Fixed

- `kit agent-audit` and `kit check` read the hooks in Codex's `.codex/config.toml`, Cursor's `.cursor/hooks.json` and Gemini CLI's `.gemini/settings.json`, with the same malware-shape and project-script checks as `.claude/settings.json`. kit writes its own gate into all three, but a hook there that piped a download into a shell gave no row: the TOML file was read for secrets only, and the Cursor and Gemini files were not read at all. Cursor's flat hook entries are read as well as the nested shape.
