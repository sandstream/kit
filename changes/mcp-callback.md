### Added

- `kit mcp callback [--for <authorization URL>] [<address> | -]` finishes an OAuth sign-in whose `localhost` callback page cannot load because the listener is on another machine than the browser. It checks the pasted address (one `state`, one `code` or one `error`, no userinfo or fragment, a loopback host, and with `--for` the sign-in's own `redirect_uri` and `state`), makes one request without following redirects, and prints the host and HTTP status, never the address. It stores nothing. The gates refuse it from an agent's shell tool.
