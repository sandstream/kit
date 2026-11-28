### Added

- **`kit check` and `kit agent-audit` warn when Cline runs shell commands without asking.** Cline
  keeps its auto-approve in `~/.cline/data/globalState.json` (or `$CLINE_DATA_DIR`,
  `$CLINE_DIR/data`), and kit read none of it: with "Execute commands" on, `kit check` had no Cline
  row at all. It now warns (`cline auto-approve`, high) on `executeSafeCommands` or
  `executeAllCommands`, and on the removed `yoloModeToggled` / `autoApproveAllToggled` toggles that
  older Cline builds still read, as `kit agent-audit` reports Claude Code's `bypassPermissions`. The
  VS Code state database of pre-file-store Cline builds is not read.
