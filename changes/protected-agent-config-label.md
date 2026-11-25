### Fixed

- **`kit agent-config` says `appended` when it adds its block to an existing rules file.** It
  printed `Claude Code → CLAUDE.md (created)` after appending to the user's own `CLAUDE.md`, which
  reads as if the file had been replaced. An existing file with content is now reported as
  `appended` ("appended kit block to CLAUDE.md"); `created` is kept for a new or empty file.
