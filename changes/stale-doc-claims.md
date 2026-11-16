### Fixed

- **Stale claims about kit itself.** `CLAUDE.md` and `AGENTS.md` said `docs/adr` holds seven ADRs (it holds nine, and ADR-0008 and ADR-0009 were unnamed); `docs/CLI_STABILITY.md` listed 23 experimental commands of 27 (`rig`, `services`, `upstream` and `worktree-gates` were missing); `kit self-audit --help` said 12 rules (there are 16). The ADR text no longer states a count, the help no longer states a number, and a test holds the stability list to the command tier table.
