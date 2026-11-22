### Fixed

- `kit triage skill <plugin>` now reports the MCP servers a Claude Code plugin registers (`.mcp.json`, or `mcpServers` in `plugin.json`). It warns when a server runs a program from `PATH` that the plugin does not ship, runs an unpinned package runner, or is remote. A plugin's MCP server starts with every session and was not reported at all.
