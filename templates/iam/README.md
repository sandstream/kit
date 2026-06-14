# Minimal-scope IAM / PAT templates

Per-vendor token-scope templates kit needs. Each `*.json` declares the
**absolute minimum** permissions for kit's plugin to function. Copy the
scope-list into the vendor's UI when creating a PAT / API token / IAM role
— **don't paste the JSON itself** unless the vendor explicitly accepts that
format (only AWS / GCP / Azure do).

## Format

Every template follows this shape:

```jsonc
{
  "vendor": "<name>",
  "purpose": "<one-line why kit needs the token>",
  "kit_plugin": "<package name (e.g. sandstream-kit-plugin-vercel)>",
  "env_var": "<environment variable that holds the token>",
  "creation_url": "<vendor UI to create the token>",
  "minimum_scope": { ... },     // vendor-shaped scope list / IAM JSON
  "docs": "<vendor docs link>",
  "last_reviewed": "<YYYY-MM-DD>"
}
```

## Why minimal-scope matters

kit's threat-model promises every credential it touches is scoped to the
narrowest possible surface. The operator stays in control: if a token is
ever leaked, the blast radius equals the scope below — never the whole
account. See `docs/THREAT_MODEL.md`.

## Vendor list

| Template | Token type | Vault env var |
|---|---|---|
| `supabase.json` | Management API PAT | `SUPABASE_ACCESS_TOKEN` |
| `vercel.json` | Account API Token, project-scoped | `VERCEL_TOKEN` |
| `github.json` | Fine-grained Personal Access Token | `GITHUB_TOKEN` |
| `stripe.json` | Restricted API Key | `STRIPE_SECRET_KEY` |
| `cloudflare.json` | Account API Token | `CLOUDFLARE_API_TOKEN` |
| `fly.json` | App-scoped deploy token | `FLY_API_TOKEN` |
| `sentry.json` | Auth Token (Internal Integration or User Token) | `SENTRY_AUTH_TOKEN` |
| `aws-sm.json` | IAM policy attached to user/role | (uses AWS credentials chain) |
| `gcp-sm.json` | IAM role bound to service account | `GOOGLE_APPLICATION_CREDENTIALS` |
| `azure-kv.json` | RBAC role assignment on Key Vault | (uses az login) |

## Verifying a token's scope

After creating the token, run:

```bash
# from a project using the plugin:
kit check
```

A successful read-only `check` confirms the token is wired correctly. If
write-capable ops (e.g. `kit secrets rotate`) fail with 401/403, the
scope is too narrow — add the next permission the error names.

## Re-reviewing

Every template has a `last_reviewed` date. When a vendor changes its
permission model (Stripe Restricted Keys, GitHub fine-grained PATs evolve
often), bump that date and re-verify the scope-list against the current
vendor UI.
