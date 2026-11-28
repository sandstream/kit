### Fixed

- **CLI `kit check` now saves its run to `.kit/runs/`, as the MCP `kit_check` tool already did.**
  `kit usage` reads the last saved run and, with none, says to run `kit check`; after any number
  of CLI runs it still said *"No saved check run"*, because only the MCP tool wrote the file. Both
  text and `--json` runs are saved now, through the same store (newest 10 kept, nothing written in
  read-only mode). Found in the kit-research note `audit-year-evidence-vs-kit`.
