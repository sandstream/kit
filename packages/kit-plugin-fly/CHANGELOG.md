# Changelog

## 0.3.0

- **New: Machines REST secrets**, the route Fly documents (docs.fly.io/api/machines/openapi.json). `listAppSecretsV1` (names and digests only, never values), `setAppSecretsV1` (several secrets in one request), `deleteAppSecretV1`. Both writes return the app's secrets `version`; running Machines pick a change up only when created or updated with `min_secrets_version` set to it. The plugin restarts nothing.
- The GraphQL functions (`listAppSecrets`, `setAppSecrets`, `unsetAppSecrets`) are kept for existing callers and documented as the older route.
- Fly error bodies now also mask the secret values being set.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client token and recognized credential patterns from GraphQL and Machines API error details.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
