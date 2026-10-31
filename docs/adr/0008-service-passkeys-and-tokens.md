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

## Kit approvals

Kit has no browser-facing approval server. Kit does not add WebAuthn to its local approval flow.
Existing local permission and approval controls handle human approval. Revisit WebAuthn only if Kit
later adds remote human approval with a verifier and a recovery process.

## Recovery

- For a lost service passkey, use the provider's account recovery. Remove the lost passkey
  and register a new one in the provider account. Kit never handles recovery codes.
- For an expired provider CLI session, run `kit login --service <name>` again. For an
  automation token, rotate it in the configured secret source and update its consumers.
- For a lost Kit signing key, use Kit's separate identity process. Rotate a software
  identity with `kit identity rotate`. Rotate a hardware identity in its key provider.
  Update trust anchors for the new public key. Verification of old records still needs
  the old public key.
