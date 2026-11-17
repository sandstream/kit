### Fixed

- **`kit triage mcp --tools` reads a raw `tools/list` response.** The usage line asks for one, and the JSON-RPC envelope (`{ jsonrpc, id, result: { tools } }`) gave "no tool definitions found".
- **`kit triage mcp` no longer flags "design system" as a dangerous capability.** A bare `system` matched; `system` now counts only as a call (`os.system`, `system command`). The finding names the field that matched (`name` or `description`), where it always said `name`.
