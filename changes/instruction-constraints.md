### Added

- **`kit check` warns when an agent instruction rule names code that is gone, or when a rule line was dropped since the last commit.** Two new rows in `kit check --category security` read kit's one instruction-file list (Claude Code, Codex, Cursor, Gemini CLI, Copilot, Windsurf).
  - `instruction rules naming missing code` lists a rule line ("never", "do not", "always", "only", …) whose backticked path, function or env var no longer exists. That covers a path that is deleted but still in git history, a name that is in `HEAD`'s code but gone from the working tree, and a required path missing from a directory that exists. Paths resolve relative to the instruction file as well as the root.
  - `instruction rules removed since HEAD` lists each committed rule line that the working tree removed, or weakened from "never" to "avoid" or "prefer not".
  - Both are low-severity warnings, never failures. Both are deterministic, use no model, and use bounded reads; git is only read.
  - Measured false positives: 0 of 16 code tokens on kit, and 0 of 48 on two third-party repositories. Planted controls in a kit copy gave 4 of 4 dangling references and 3 of 3 removed or weakened lines.
  - This extends the rule-word test of `skill rules without a gate` from skill directories to every instruction file. Found by the kit-research note shrink-anything-vs-kit.
