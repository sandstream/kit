# Changelog

## 0.3.0

- Issue retrieve/update and issue events use the org-scoped path Sentry documents (`/api/0/organizations/{org}/issues/{id}/`) whenever an organization is known, from the client or the new `organizationSlug` option. The short `/api/0/issues/{id}/` form, no longer documented, is kept only as the fallback without one. Issue comments are undocumented in both forms and unchanged.
- `getIssueEvents` takes an optional `organizationSlug`.
- Previous package manifest version: `0.2.2`.

## 0.2.2

- Redacts the client token and recognized credential patterns from Sentry REST error bodies.
- Treats `KIT_READ_ONLY=yes` and `KIT_READ_ONLY=on` as read-only for write operations.
- Added package-specific installation, configuration, and API documentation.
- Previous package manifest version: `0.2.1` (verified in git history).
