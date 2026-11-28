### Added

- **`kit agent-audit` reads Claude Desktop's MCP servers.** `claude_desktop_config.json` declares
  stdio servers that start with the person's credentials when the app opens, often with API keys in
  their `env`, and kit did not read it. It now gets the checks every other MCP config gets:
  plaintext secrets, malware-shaped or inline-code launch commands, and unpinned `npx`/`uvx`
  runners. Paths per OS, from modelcontextprotocol.io/docs/develop/connect-local-servers: macOS
  `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`
  (or `$XDG_CONFIG_HOME/Claude/`). Desktop extensions (`.mcpb`) are not read (kit-research
  `nvidia-auto-ontology-vs-kit`).
