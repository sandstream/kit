# Secrets Lifecycle

A secret's *name* belongs in the repo; its *value* never does. Config references a
key (`DATABASE_URL`, `STRIPE_SECRET_KEY`); the value is resolved at runtime from a
secret store. If a value reaches git history, a script, a CI log, or a screenshot,
it is compromised — go to [Leak response](#leak-response). This guide is the decision
layer that pairs with kit's vault backends and its secret prescan (`kit prescan`,
backed by gitleaks): the scan and the vault enforce *where values live*; this doc
owns the part tooling can't — how you provision, rotate, and respond when a value
leaks.

## Provision

- Commit an `.env.example` of key **names + purpose only** — never a real value.
  kit's `.env.template` follows this convention.
- Mint a fresh, scoped credential per service per environment (dev/staging/prod);
  one leaked dev key must not unlock prod.
- **Never inline a secret in a script.** The classic anti-pattern is a backup
  script with the DB password in the connection string so cron "just runs it" —
  that value is now in git, in shell history, in every CI log, and in `ps`. Read
  it from the environment instead:

  ```bash
  # BAD — secret committed forever:
  pg_dump "postgresql://admin:S3cr3tP@ss@db/app" > backup.sql
  # GOOD — injected at runtime, file is safe to commit:
  : "${DATABASE_URL:?DATABASE_URL not set}"; pg_dump "$DATABASE_URL" > backup.sql
  ```

- Keep secrets off the command line (visible in `ps`/history); use env or a file.

## Store

- One source of truth: a managed **secret store / vault** — not a doc, chat, or
  hand-passed `.env`. A vault gives you access control, audit logs, versioning,
  and rotation in one place. kit supports a range of vault backends so the same
  config resolves against whichever store a team already uses.
- Inject at runtime (a `run`/`exec` wrapper that loads the vault, a sidecar, or a
  platform env binding); don't copy values around. Local dev uses a gitignored
  `.env.local` sourced from the store. Scope least-privilege per environment.
- Defense at the boundary: a pre-commit secret scan (`kit prescan`) plus the host's
  push protection; `.env*` gitignored except `.env.example`.

## Rotate

Rotate on a **cadence** (≈90 days for API/DB keys; 180 for signing/webhook
secrets) **and** on any trigger (leak, offboarding, vendor advisory). Zero-downtime
procedure: **issue** new → **store** it → **roll out** → **verify** → **revoke**
old → **record** the date so the next rotation is scheduled. Use a dual-key window
where the provider allows two live keys.

## Leak response

A secret is leaked the moment its value lands anywhere uncontrolled. Assume
compromise — don't debate it. **Revoke within minutes; fully rotated within the
hour.** Scrubbing git history does *not* un-leak it; revoking does.

1. **Detect & contain** — which secret, where, exposure window. Start the clock.
2. **Revoke/rotate first** — invalidate the exposed value at the provider, then
   issue + store + roll out a replacement. This is the action that closes the door.
3. **Rotate dependents** — anything derived from, sharing a key with, or reachable
   *using* the leaked secret (session keys, downstream tokens). Map blast radius
   from vault access scopes.
4. **Audit for abuse** — provider + store logs for the window: odd IPs, unusual
   calls, data egress, new keys/grants. Escalate if abuse found.
5. **Document** — short post-incident note: what leaked, root cause, window,
   actions + timestamps, and the prevention fix; feed it back into your runbook.

| Step | Target |
|---|---|
| Detect → revoke | minutes |
| Replacement rolled out | < 1 hour |
| Dependents rotated | same incident |
| Abuse audit | < 24 hours |

> Deleting the secret from a file or rewriting history is **not** remediation.
> Once exposed, the only fix is to make the value worthless by revoking it.
