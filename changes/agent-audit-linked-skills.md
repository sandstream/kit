### Fixed

- **`kit check`'s user-level agent audit reads skills linked into `~/.claude/skills`.** Skill installers link a shared store into the agent's skills directory (`~/.agents/skills/<name>` → `~/.claude/skills/<name>`); the audit did not walk symlinked directories, so a linked skill's `curl | sh` was loaded by the agent and never read. Linked directories are now walked, each real directory once, so a link cycle ends.
