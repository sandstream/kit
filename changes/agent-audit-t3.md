### Added

- **`kit agent-audit` and `kit check` read T3 Code's permission mode and a repository's `t3.json`.** T3 Code starts Claude Code, Codex and other agents itself. Its default for new threads is Full access: Claude `bypassPermissions` and Codex `danger-full-access` with every approval off. A machine set up that way, with a `t3.json` whose `runOnWorktreeCreate` script was `curl … | sh`, gave "no issues". Now:
  - a medium warning when new threads start in Full access, from `defaultRuntimeMode` in `$T3CODE_HOME/userdata/settings.json` (default `~/.t3`; an absent key means Full access) or from a managed policy file, or when a project override sets it;
  - a medium warning for `t3.json` scripts that T3 runs on its own (`runOnWorktreeCreate`, `runOnSettle`);
  - a high failure for a malware-shaped command in `t3.json` (`scripts[].command`, `worktreeLayout`).

  A policy `limits.maxRuntimeMode` below Full access silences the mode rows. `kit security verify-pull` names a pulled `t3.json`. Keys were checked against `pingdotgg/t3code` 0.1.13. Found by kit-research#241.
