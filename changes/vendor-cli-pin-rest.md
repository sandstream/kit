### Security

- **The vendor-CLI pin now covers the deploy and credential CLIs, and every call to one CLI starts the same file.** `eas` (secret backend, `kit check` probe, Expo adapter), `dotenvx` (read and write), the `vercel`, `supabase`, `fly`, `railway`, `wrangler` and `stripe` adapters, every `kit secrets propagate` target (`gh`, `fly`, `wrangler`, `railway`, `aws`, `vercel`, `supabase`), the `vercel env ls` deploy check, the Infisical login probe, `[services.*].check`/`kit login` commands and `op signin` now run behind the pin, and `kit tools pin` accepts `eas`, `dotenvx`, `vercel`, `supabase`, `fly`, `flyctl`, `railway`, `wrangler` and `stripe`. Pinned or not, every call resolves a CLI the way the pin measures it (mise first, then PATH), so `op whoami` and `op read` can no longer start two different binaries. A refused `secrets propagate` push never starts the CLI and reports exit 126 with the reason (kit-research#232).

### Fixed

- **A vendor-CLI pin refusal inside `kit mcp` no longer marks the whole server as failed.** The refusal is now that tool call's error (`isError`, with the reason), and leaves the server's exit code and later calls alone. The CLI still exits non-zero.
