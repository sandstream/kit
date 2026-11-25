### Fixed

- **`kit triage skill` reads what a skill or plugin runs wherever it is declared.** Found by measuring Anthropic's skills, official plugins and knowledge-work plugins, and OpenAI's codex-security:
  - a standalone skill's scripts were scanned for secrets only; they now get the line rules a plugin's scripts get (a `setup.sh` piping a download into a shell scored 100/100 in a skill and two warnings in a plugin);
  - hooks a `SKILL.md` declares in its frontmatter (`hooks: PreToolUse …`, as claude-plugins-official `claude-security` does) were not read; they are judged as plugin hooks are;
  - an MCP server with an empty `url` (a placeholder) or a loopback host was reported as remote; they are now named as a placeholder and as a server on this machine;
  - an `.mcp.json` that `plugin.json` also names was counted twice;
  - `lspServers` were not read, so twelve official plugins that start a language server from PATH read as "0 MCP server(s)", 100/100; they are reported, and one from PATH is a warning;
  - `kit triage repo <local path>` sent every local folder to `kit triage skill`, which fails a project that is not a skill; it now names both commands.
