### Changed

- `kit check` and `kit agent-audit` warn about a hook that runs a project file on every hook event, not only `SessionStart`. The same script wired on `Stop`, `PostToolUse`, `UserPromptSubmit`, `PreCompact` or `PreToolUse` gave "no issues", although the harness runs it outside every tool-call gate. One warning per event and file; a repository with such hooks sees new warnings.
