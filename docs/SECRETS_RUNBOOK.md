# Secrets runbook

A project-level template for handling secrets across their whole lifecycle —
provision, store, rotate, and respond to a leak. Copy it into a repo as
`SECRETS.md` (or `docs/secrets.md`) and fill the bracketed `[…]` slots for your
project. It pairs with kit's secret-scan (gitleaks-backed prescan), supply-chain
scan, and vault backends; this file covers the part tooling can't: the *values*
and what to do when one escapes.

Core rule: **a secret's name lives in the repo; its value never does.** Config
references a key (`DATABASE_URL`, `API_KEY`); the value is resolved at runtime
from a secret store. If a value is in git history, a script, a CI log, or a
screenshot, treat it as compromised — see Leak response.

## 1. Provisioning

- **Values are not names.** Commit an `.env.example` listing every key and a
  one-line purpose — names and shape only (`API_KEY=`), never a real value. Code
  reads `process.env.X` / `os.environ["X"]`; it never contains the literal.
- **Generate, don't reuse.** Mint a fresh credential per service per environment
  (dev / staging / prod). One leaked dev key must not unlock prod. Use the
  provider's own key issuance (restricted/scoped keys where offered) rather than a
  long-lived root key.
- **Never in scripts.** The classic failure is the convenience anti-pattern: a
  backup or deploy script with the password inlined so it "just runs from cron":

  ```bash
  # ANTI-PATTERN — do not do this. Secret is now in git, in shell history,
  # in every CI log that echoes the command, and in the process table (`ps`).
  pg_dump "postgresql://admin:S3cr3tP@ss@db.internal/app" > backup.sql
  ```

  The fix: the script reads the value from the environment, which is populated
  from the secret store at run time — the literal appears nowhere in the repo:

  ```bash
  # OK — value injected at runtime; the file is safe to commit.
  : "${DATABASE_URL:?DATABASE_URL not set}"
  pg_dump "$DATABASE_URL" > backup.sql
  ```

- **No secrets on the command line.** Args are visible in `ps` and shell history;
  prefer env vars or a file the tool reads. Don't `echo` secrets in CI.

## 2. Storage

- **One source of truth: a secret store / vault.** Keep values in a managed store
  (e.g. Vault, AWS/GCP Secrets Manager, 1Password, Doppler, Infisical, or any of
  kit's supported vault backends) — not in a shared doc, chat, or a `.env` passed
  around by hand. The store gives you access control, audit logging, versioning,
  and rotation in one place.
- **Inject, don't copy.** Runtime pulls from the store (sidecar, a vault CLI's
  `run -- <cmd>` wrapper, platform-native env binding). Local dev uses a
  per-developer `.env.local` that is gitignored and sourced from the store, never
  emailed or pasted.
- **Scope and least-privilege.** Separate vault scopes per environment; grant each
  human/service only the keys it needs. Production secrets are not readable from a
  laptop by default.
- **Guard the boundary.** A pre-commit secret scan (e.g. gitleaks, as kit's
  prescan runs) and a server-side push protection catch the literal before it
  lands. `.env*` (except `.env.example`) is gitignored.

## 3. Rotation

Rotate on a cadence *and* on any trigger (leak, offboarding, vendor advisory).

| Secret class | Cadence | Notes |
|---|---|---|
| App/API keys, tokens | every 90 days | scoped keys, dual-key window to avoid downtime |
| Database / infra creds | every 90–180 days | coordinate with connection pools |
| Signing / webhook secrets | every 180 days | overlap old+new during cutover |
| OAuth client secrets | per vendor policy | |
| Anything exposed in a leak | immediately | see Leak response |

**Zero-downtime rotation procedure:**

1. **Issue** a new credential in the provider (don't delete the old yet).
2. **Store** the new value in the vault as the active version.
3. **Roll out** — deploy/restart so running processes pick up the new value.
   Where the provider supports two live keys, run both during the window.
4. **Verify** the new value works in each environment (a smoke call, a signed
   webhook round-trip).
5. **Revoke** the old credential at the provider and prune it from the store.
6. **Record** the rotation date so the next cadence is scheduled.

## 4. Leak response (incident runbook)

A secret has leaked the moment its value lands anywhere uncontrolled — git
history, a public repo, a CI/build log, a paste, a screenshot, a client bundle,
or a third-party breach. Assume compromise; do not debate it.

**Target time-to-restore: revoke within minutes, fully rotated within the hour.**
A live exposed credential is an open door — speed beats tidiness.

1. **Detect & contain.** Confirm which secret, where it surfaced, and the window
   it was exposed. Do **not** try to "scrub" git history first — that does not
   un-leak it; revoking does. Start the clock.
2. **Revoke / rotate the leaked secret first.** Invalidate the exposed value at
   the provider immediately, then issue + store + roll out a replacement
   (the rotation procedure above). Revocation is the action that closes the door;
   everything else follows.
3. **Rotate dependents.** Any secret derived from, sharing a key with, or reachable
   *using* the leaked one is also suspect — session signing keys, downstream
   service tokens, anything the exposed credential could have read. Rotate them
   too. Map the blast radius from the vault's access scopes.
4. **Audit for abuse.** Pull provider + store access logs for the exposure window:
   unexpected IPs, unusual calls, data egress, new keys/grants created with the
   stolen credential. Escalate to an incident if abuse is found.
5. **Document.** Write a short post-incident note: what leaked, root cause (how the
   value escaped), exposure window, actions + timestamps, and the prevention fix
   (e.g. enable push protection, add the missed path to `.gitignore`, move the
   value out of a script — section 1). Feed the fix back into this runbook.

### Time-to-restore targets

| Step | Target |
|---|---|
| Detect → revoke leaked secret | minutes |
| Replacement issued + rolled out | < 1 hour |
| Dependents rotated | same incident |
| Abuse audit complete | < 24 hours |
| Post-incident note written | < 48 hours |

> Removing a secret from a file or rewriting git history is **not** remediation.
> Once a value is exposed, the only fix is to make that value worthless by
> revoking it. Rewrite history only as cleanup *after* rotation.
