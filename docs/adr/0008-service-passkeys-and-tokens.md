---
id: ADR-0008
title: Service passkeys and tokens have separate owners
status: accepted
---

# ADR-0008: Service passkeys and tokens have separate owners

## Decision

The service provider and the user's passkey manager own human authentication. Kit runs the provider's login command and checks the resulting CLI session. Kit does not create, import, store, export, or request a passkey private key.

Automation and application credentials use separate service tokens. Store these tokens in a configured secret source. Give each token the smallest available scope and an expiry when the provider supports it. A provider CLI owns its local session. Kit's Ed25519 identity signs Kit records; it does not authenticate to a service.

## Reason

A successful service check proves that the CLI has a usable session. It does not prove which method the person used to log in. Vercel uses a browser device flow for CLI login. Supabase browser login creates a token with full account access. Supabase also supports scoped tokens for CLI and CI. Stripe recommends restricted API keys and secret vaults.

Sources: [Vercel CLI login](https://vercel.com/changelog/new-vercel-cli-login-flow), [Supabase tokens](https://supabase.com/docs/guides/platform/personal-access-tokens), [Stripe API keys](https://docs.stripe.com/keys).

## Consequences

- `kit login --plan` marks possible browser or passkey approval. This mark is not proof of passkey use.
- `kit login` delegates human authentication to the provider CLI and checks its result.
- A comment-only login entry means manual setup. Kit does not run it as a command.
- The `capture` strategy remains a plan. Kit does not execute token capture through `kit login`.
- Service tokens, provider CLI sessions, and Kit's signing identity remain separate credentials.
