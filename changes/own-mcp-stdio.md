### Changed

- `kit mcp` serves MCP with kit's own stdio server (`src/mcp-stdio.ts`, JSON-RPC 2.0 over standard input and output) instead of `@modelcontextprotocol/sdk`. A production install goes from 92 packages to 2 (`smol-toml` and `zod`). The SDK is a development dependency that the tests use as the reference server: the same messages go to both servers and every answer is compared, for the ten kit tools. The tool list, the schemas, the error text and the protocol version negotiation are the same.
