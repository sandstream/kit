### Added

- **`kit check` finds secrets in agent instruction files, for every harness.** A new
  `instruction-file secrets` row reads `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`,
  `CLAUDE.local.md`, `SKILL.md`, `.claude/{rules,commands,agents}/**/*.md`, `.cursorrules`,
  `.cursor/rules/*.mdc`, `GEMINI.md`, `.github/copilot-instructions.md` and `.windsurfrules` (any
  letter case), from kit's one instruction-file list, with the shared `findSecrets` patterns. A
  match fails at critical and names the file and the pattern, never the value. Before, a key in
  `AGENTS.md`, `.cursorrules` or `GEMINI.md` produced no row: `agent-audit` reads configs, and
  `triage instructions` reads these files for injection only.
