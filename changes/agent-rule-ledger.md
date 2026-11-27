### Added

- **`kit agent-audit` lists every saved allow, ask and deny rule, one row per rule, and reports
  new allow rules and removed deny or ask rules.** Each row has the harness, scope (user,
  project, local or managed), file, rule, kind, a class from the lethal-trifecta tables and the
  date kit first saw it; `--json` adds them as `rules`. It reads Claude Code's `permissions` in
  user, project, local and managed settings (`managed-settings.json` and `managed-settings.d` per
  OS), Codex `prefix_rule(...)` in `$CODEX_HOME/rules` and `.codex/rules` (as text, never
  evaluated; anything it cannot parse is reported, not dropped), Cursor CLI's `cli-config.json`
  and `.cursor/cli.json`, and Gemini CLI's `tools.allowed`, `tools.exclude`, `autoAccept` and
  `auto_edit`. A non-Claude allow rule that holds all three legs (`prefix_rule(pattern=["bash"])`,
  `Shell(bash)`) warns. `~/.kit/agent-rules.json` records the accepted rules, and `kit check`
  reports the same findings until a person runs `kit agent-audit --accept-rules`, which the gates
  refuse from an agent. Antigravity, Copilot CLI and the other harnesses' rule stores are not
  read, and the output names them. Found by kit-research#239: a permission reply can rewrite these
  files, and removing five of kit's own deny rules changed no row.

### Fixed

- **The lethal-trifecta pass row says which grants it read.** It said "no agent holds untrusted
  input, private data and a way out" while reading only Claude Code's settings, so a Codex or
  Cursor rule allowing `bash` sat under a ✓. It now names the Claude Code files it read.
