### Added

- **`kit agent-audit` prints the skill posture.** One row per skill installed for the agent, in this checkout (`.claude/skills/<name>/SKILL.md`) and at user level (`~/.claude/skills`), with its declared `allowed-tools` and who may invoke it. Values a skill does not declare are printed as the spec default and marked `(default)`, because a skill that declares nothing has the widest posture: all tools, invocable by the model on its own. A missing or wildcard `allowed-tools` is a warning, as in `kit skill test`; the exit code does not change.
