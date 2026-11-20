### Added

- **`kit agent-config --plan` shows what it will change in the Claude Code settings before it
  writes them, and `--apply <hash>` writes only that plan.** `--plan` writes nothing (no settings,
  gate marker, wrapper or rules file): it runs the existing writers on a temporary copy of
  `.claude/settings.json` and `.claude/settings.local.json` (or `~/.claude/settings.json` with
  `--user`) and prints a line diff per file, two checked invariants (nothing outside `hooks`
  changes except the keys agent-config owns: `permissions.allow`, `permissions.deny`,
  `sandbox.enabled`, `sandbox.filesystem.denyRead`; every hook entry that is not kit's is still
  there, in the same order), and a `plan hash`. `--apply <hash>` recomputes the plan and refuses
  with a non-zero exit when the hash differs. A plain `kit agent-config` writes as before and
  prints the same diff first, except with `--non-interactive` or in CI.
