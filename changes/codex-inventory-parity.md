### Fixed

- **`kit insight`, `kit profile freeze` and `kit sbom --agent` see Codex's skills and MCP
  servers.** They read skills from `.claude/skills` and MCP servers from JSON configs only, so a
  skill in `.agents/skills` or `.codex/skills` and a server in `[mcp_servers]` in
  `.codex/config.toml` were absent from the inventory and the frozen profile. All three are read
  now; a name in two places is listed once, Claude Code's entry first. Skill usage in
  `kit insight` still counts only Claude Code's `Skill` tool, so a Codex skill shows as `unknown`,
  not `used`. Found in kit-research `uber-skills-at-scale-vs-kit`.
- **`kit agent-audit`'s skill posture lists Codex's skills.** It read `.claude/skills` and
  `~/.claude/skills` only. It now also reads `.agents/skills`, `.codex/skills`, `~/.agents/skills`
  and the Codex home's `skills` (`$CODEX_HOME`, default `~/.codex`), and lists a skill linked
  between two of them once.
