### Changed

- **Exit codes, read-only mode and `kit run` child execution moved from `docs/COMMANDS.md` to `docs/CLI_RUNTIME.md`.** `docs/COMMANDS.md` sat at exactly the 600-line standards cap, so any pull request that documented a new flag or rule there failed the size gate. The text is unchanged; `docs/COMMANDS.md` links the new page from its intro and `docs/MCP_TOOLS_REFERENCE.md` now points at the moved `#child-command-execution` anchor. No behaviour change.
