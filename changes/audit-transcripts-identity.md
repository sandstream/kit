### Added

- **`kit audit transcripts --identity` (experimental) counts agent tool calls that carried your own identity.**
  Claude Code once put the signed-in account's address into requests agents wrote, and agents read
  git's author name and address from `git log`. The command builds the identity set (effective git
  `user.email` and `user.name`, and `oauthAccount.emailAddress` from `~/.claude.json` or
  `$CLAUDE_CONFIG_DIR`), streams `~/.claude/projects/**/*.jsonl` within file-count, size and depth
  caps, and counts the `tool_use` inputs that hold one of them: by identity kind, by tool, and by
  destination host for network-shaped calls (`curl`, `wget`, a URL, a `User-Agent` or `From`
  header, `fetch`, `requests`, `urllib`, `WebFetch`, `WebSearch`, `mcp__` tools). Offline and
  read-only; it never prints an identity value. `--json` for machines; exits 0 unless
  `--fail-on-network` is given and a network-shaped call exists. Found in kit-research
  `claude-code-account-email-user-agent-vs-kit`. Experimental: its output shape and network
  classification may change before it is marked stable.
