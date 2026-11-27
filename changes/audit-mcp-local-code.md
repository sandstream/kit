### Fixed

- **`kit agent-audit` warns when a project MCP server runs the checkout's own code at session
  start.** ARTEX-CC's committed `.mcp.json` runs `go run ./cmd/artex-cc serve`, which compiles
  and runs whatever the checkout holds each time an agent starts, once the project server is
  approved; `kit agent-audit` said "no issues". `go run ./…`, `cargo run`, `node ./…` and other
  interpreters on a relative path, `python -m <a package in the checkout>`, `npm|pnpm|yarn|bun
  run`, `uv run` and a relative command now get a low warning, "runs repository code at session
  start" (kit-research#236).
- **`kit agent-audit` and `kit triage skill` now agree that `npx -y <pkg>` and `uvx <pkg>`
  without a version are unpinned.** `triage skill` warned on such an MCP entry and `agent-audit`
  passed it, by a choice recorded in its code: failing every `npx` config would be noise. That
  choice stands, so it is still not a failure. `agent-audit` gives a low warning that names the
  runner and the package, using the triage skill's runner list and pinned test (`name@1.2.3`), in
  every project config it reads, Codex's `config.toml` included (kit-research
  `shrink-anything-vs-kit`).
