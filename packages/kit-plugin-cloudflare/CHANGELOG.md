# Changelog

## 0.3.0

- **New: account-owned API tokens.** `listAccountApiTokens` and `revokeAccountApiToken` (`/accounts/{account_id}/tokens`). Account tokens are separate from user tokens, so a rotation sweep built on `listApiTokens` (`/user/tokens`) never saw them. Revoking is gated by the same `api_token_revoke` op.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client token and recognized credential patterns from HTTP and Cloudflare API error details.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
