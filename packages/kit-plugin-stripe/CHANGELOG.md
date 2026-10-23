# Changelog

## 0.3.0

- Pins Stripe API `2026-09-30.endive` (was `2024-12-18.acacia`, four named generations behind). The basil, clover, dahlia and endive changelogs change no field this plugin reads.
- `createWebhookEndpoint` now sets `api_version` (default: the pinned version; overridable). Before, endpoints it created received events in the account's default Stripe version, not the one the plugin was built against.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client secret key and recognized credential patterns from Stripe API error bodies.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
