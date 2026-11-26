### Added

- **`kit security scan-outbound <file|->` fails when outbound text repeats a private agent
  instruction file.** A PR body, commit message or release note is matched against the instruction
  files the repository does not publish (untracked or ignored `CLAUDE.local.md`, `AGENTS.override.md`,
  `.claude/**/*.md` and the other instruction files kit knows) and the user-level ones of Claude
  Code (`~/.claude`) and Codex (`$CODEX_HOME` or `~/.codex`), by character n-gram overlap: the
  method of PyRIT's `SystemPromptExtractionScorer`, with no model and no network. A span of 40
  characters or more (`--min-chars`) exits 1 and prints the span (redacted, capped at 120
  characters), the private file and its line, never the file itself. Text that a tracked
  instruction file also holds is public and does not count. `--json` for scripts. It covers OWASP
  LLM07 (system prompt leakage) for outbound text only; `scripts/prepush.mjs` does not run it yet.
