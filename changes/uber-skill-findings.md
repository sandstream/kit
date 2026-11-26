### Fixed

- **`kit triage skill <pack>` judges the MCP servers in a pack's root `.mcp.json` and in
  `[mcp_servers]` in `.codex/config.toml`.** Both were declared NOT CHECKED, so a pack registering
  `npx -y server@latest` and a remote host scored with no MCP finding. They are now judged by the
  rules a plugin's servers are (unpinned runner, remote host, program from `PATH`). A
  `config.toml` that holds more than `mcp_servers` stays declared not checked. Found in kit-research
  `uber-skills-at-scale-vs-kit`.
- **A `.kit/standards.d` forbid rule that read zero files is incomplete, not `no matches`.** A
  rule whose extensions selected no file (for example a skill rule without `exts = [".md"]`)
  passed under `--enforce` having checked nothing. It now reports once as incomplete and fails
  under `--enforce`, as an empty require scope already did.
- **`kit skill test` and `kit agent-audit` read Claude Code's `user-invocable` field.** kit read
  only `user-invokable`, a spelling Claude Code does not document, so `user-invocable: false` was
  reported as the default. Both spellings are read. The field comes from Claude Code's skill
  frontmatter; the agentskills.io specification does not define it.
