# Changelog

## 0.2.2

- Redacts the client token, submitted environment-variable values, and recognized credential patterns from API error bodies.
- `upsertEnvVar` now checks read-only mode and write policy before reading remote environment variables.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
