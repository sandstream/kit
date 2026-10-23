# Changelog

## 0.3.0

- Sends `X-GitHub-Api-Version: 2026-03-10`. `2022-11-28` reaches end of support on 2028-03-10, after which GitHub answers 410 Gone. None of 2026-03-10's breaking changes touches the repository secret, public-key or deploy-key calls this plugin makes.
- **New: environment and organization secrets.** `listEnvironmentSecrets` / `createOrUpdateEnvironmentSecret` / `deleteEnvironmentSecret` take an `EnvironmentRef` and use the environment's own public key, gated as `env_set` / `env_unset`. `listOrgSecrets` / `createOrUpdateOrgSecret` / `deleteOrgSecret` take an explicit visibility (`all`, `private`, or `selected` with at least one repository id), gated as the new `org_secret_set` / `org_secret_unset`, because an org secret can reach every repository.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client token and recognized credential patterns from GitHub REST error bodies.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
