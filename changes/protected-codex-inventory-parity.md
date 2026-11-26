### Fixed

- **`kit agent-audit` reads Codex's project skills and the `[mcp_servers]` in
  `.codex/config.toml`.** The MCP checks (cleartext `http://`, inline-eval or malware-shaped
  stdio commands) parsed JSON only and passed over Codex's TOML servers, and the skill-file scan
  read `.claude/skills` but not `.agents/skills` or `.codex/skills`. Both are read now. Found in
  kit-research `uber-skills-at-scale-vs-kit`.
