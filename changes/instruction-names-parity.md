### Fixed

- **`kit triage instructions` now scans Codex's `AGENTS.override.md`.** Codex reads it in
  preference to `AGENTS.md` in the same directory, and the user audit already read it in
  `$CODEX_HOME`, but the repo scan's name list lacked it, so a repo copy was never scanned.
  `kit security verify-pull` shared a hand-kept copy of that list with the same gap; it now uses the
  scan's list, and also flags `.claude/rules/` files. Found while building
  `kit security scan-outbound`.
- **`kit triage instructions` now scans `.claude/commands/**/*.md` and `.claude/agents/**/*.md`.**
  Claude Code reads slash commands and subagents as instructions, and the user audit read both under
  `~/.claude`, but the repo scan recognised only `.claude/rules/`. A new test derives the expected
  files from the user audit's own declarations, so the two lists cannot drift apart again.
