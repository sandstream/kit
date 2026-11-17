### Added

- **`kit check` warns on a loopback HTTP MCP server that sends no token.** A server on
  `http://127.0.0.1`, `localhost` or `[::1]` is reachable from any web page the user opens unless it
  checks `Host` and `Origin`. The existing row said only that kit cannot see what such a server binds
  to. The new row (warn, medium) names each loopback `http:` MCP server in the project's JSON MCP
  configs whose entry has no auth header (`headers`, `http_headers`, `requestInit.headers`), no auth
  field (`headersHelper`, `oauth`, `bearer_token_env_var`, …) and no credential in the URL. Header
  values are never printed. Found in kit-research `agent-first-localhost-guide-vs-kit`.
