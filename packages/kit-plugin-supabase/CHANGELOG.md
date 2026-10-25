# Changelog

## 0.3.0

- **New: JWT signing keys**, Supabase's successor to the JWT secret. `listSigningKeys`; `rotateSigningKey` (create standby → make in_use → demote the previous key to previously_used; reversible, revokes nothing, and never leaves the project with no key in use); `revokeSigningKey` (refuses the key in use). Gated as `signing_key_rotate` and `signing_key_revoke`, both registered in kit's policy registry.
- `rollJwtSecret` is documented as legacy. Its path is an internal dashboard endpoint, absent from Supabase's published Management API spec.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client access token and recognized credential patterns from Management API error bodies.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and rotation-API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
