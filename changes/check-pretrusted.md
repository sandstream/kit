### Added

- **`kit check` says when an agent tool already trusts this repository.** It reads Claude Code's
  `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted`, or under `$CLAUDE_CONFIG_DIR`) and
  Codex's `config.toml` (`[projects."<path>"] trust_level = "trusted"`, or under `$CODEX_HOME`),
  read-only, and names only the tool and the file. The agent's trust prompt is what stops a cloned
  repository's project hooks and MCP servers from loading, and agent managers such as Orca write the
  trust for every repository they open. The row is information, not a warning: the file cannot say
  whether the user or a tool wrote it, and accepting the prompt once is the normal state of every
  repository a user works in. Found in kit-research `orca-ade-vs-kit`.
