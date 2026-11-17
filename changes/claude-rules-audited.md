### Fixed

- **Claude Code's rules files are audited.** Claude Code loads every `.md` under `.claude/rules/`
  in a project, and under `~/.claude/rules/` in every project. `kit agent-audit` read
  `~/.claude/skills`, `commands`, `agents` and `CLAUDE.md` but not `~/.claude/rules/`, so a
  planted instruction there passed. `kit triage instructions` did not list project rules either.
  Both now read them, with the same secret, malware and instruction rules as the other surfaces.
  Found in kit-research `pstack-vs-kit`, whose setup skill writes `~/.claude/rules/pstack-models.md`.
