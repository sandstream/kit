### Added

- **`kit run --inject -- <cmd>` hands declared secrets to one process without writing `.env.local`.** It resolves `[secrets.keys]`, records the read as `secrets.read` with `via: "kit run"` before any value is fetched, and passes the values only in the child's environment, where they are redacted from its output. It neither reads nor writes `.env.local`, and the child does not start when a key cannot be resolved or recorded, or is prod-scoped outside the prod env. MCP `kit_run` takes `inject: true`. Next.js and Vite take `process.env` ahead of `.env.local`, so `kit run --inject -- next dev` and `kit run --inject -- vite` need no file. On Windows, names fold case-insensitively. Found by kit-research note `kms-decrypt-evidence-vs-kit`.
- **`kit secrets --write-env-file`** spells out today's behaviour, so scripts that need the file keep it when 8.0 flips the default.

### Deprecated

- **`kit secrets` writing `.env.local` by default.** It still writes the file in 7.x, and without `--write-env-file` it now prints one stderr line saying kit 8 stops doing so by default and pointing at `kit run --inject`. Nothing else changes in 7.x; the flip is scheduled for 8.0 in `docs/CLI_STABILITY.md`.
