# Changelog

## 0.3.0

- Sends `X-GitHub-Api-Version: 2026-03-10`. `2022-11-28` reaches end of support on 2028-03-10, after which GitHub answers 410 Gone. None of 2026-03-10's breaking changes touches the repository secret, public-key or deploy-key calls this plugin makes.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client token and recognized credential patterns from GitHub REST error bodies.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
