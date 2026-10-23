# Changelog

## 0.3.0

- **Fix:** `createEnvVar` reads v10's `{ created, failed }` answer. A create that Vercel rejected could arrive as HTTP 201 and was treated as success; in `upsertEnvVar`'s conflict path that meant deleting the old entries next. A rejected create now throws, and no delete follows.
- **Fix:** `listProjects` handles the bare-array form the v10 spec allows (reading only `.projects` would have returned an empty list).
- Env vars can be created and set as `sensitive` (Vercel's write-only type). The default stays `encrypted`.
- Moves off paths absent from Vercel's published spec: projects and env listing to `/v10`, the latest-deployment lookup to `/v7`. The header no longer claims an unimplemented `GET /v9/projects/{idOrName}`.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client token, submitted environment-variable values, and recognized credential patterns from API error bodies.
- `upsertEnvVar` now checks read-only mode and write policy before reading remote environment variables.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
