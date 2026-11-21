---
id: ADR-0011
title: Files and secrets may live in the repo as ciphertext per recipient, and no one may be locked out
status: proposed
---

# ADR-0011: encrypted per recipient in the repo, with no lockout

## Decision

kit may keep selected files and secrets in the git repository as ciphertext. Only a named
list of recipients can decrypt them. The feature is opt in and off by default.

- **Scope is files, not branches.** GitHub grants read access to a whole repository, never to a
  branch or a path. kit does not claim to add private branches. It gives the same effect for
  chosen files, which are visible to everyone and readable by the recipients.
- **One random file key per file, wrapped per recipient.** The format follows the age
  specification: an ephemeral X25519 key per recipient stanza, HKDF-SHA-256, an authenticated
  header, and AES-256-GCM chunks with a counter nonce. It uses `node:crypto` only. No new
  dependency, no own primitive (ADR-0002).
- **The recipient list is a signed manifest.** Anyone with write access could otherwise add their
  own key. An admin key signs the manifest. Each machine pins the admin key outside the repo
  and checks the signature before it wraps a key for anyone.
- **The format is versioned and fails closed.** An unknown version or stanza is an error, never
  a downgrade.
- **Opt in.** The README promise changes from "secrets never live in the repo" to "no secret
  lives in the repo in plaintext". Without the opt in, nothing changes.

## No lockout

Losing the keys must never lose the data. The design needs all of these before it ships:

- **At least two admin recipients.** `kit` refuses to write a manifest with fewer than two
  recipients that can decrypt, unless the user passes an explicit `--single-recipient` and the
  command prints the risk.
- **A recovery recipient.** `kit secrets recovery init` creates one extra X25519 key. It is
  printed once, to be stored offline (paper or a separate vault). It is a normal recipient in
  every file, so it needs no special decryption path. It is never stored by kit.
- **Re-encrypt before removal.** `remove-recipient` first checks that every file still opens for
  at least two remaining recipients. It refuses otherwise.
- **A check that proves access.** `kit check` decrypts a canary file with the local key and
  reports `fail` if this machine can no longer read the files it should. A lost key then shows
  as a red check, not as a surprise during a deploy.
- **Plaintext source stays recoverable.** `kit secrets` keeps the vault as the source of truth
  for values. The repo copy is a distribution format. A repo with no usable key can be rebuilt
  from the vault.
- **Signing key loss.** If the admin key is lost, the recovery recipient can sign a new manifest
  after the owner approves it. The approval is an audit row (ADR-0010 applies to any ask).

## Rationale

- **GitHub cannot limit reads.** Rulesets, push rulesets and CODEOWNERS limit writes and
  review only. No per-path or per-branch read access was found in the primary documentation.
- **age is the model.** Its design is specified, small, and maps to `node:crypto`. kit already
  has X25519, HKDF and AES-256-GCM in `src/memory/backup.ts`, for one recipient.
- **git-crypt is the warning.** It is all or nothing per repo, has no user removal, and leaks
  file names and equal files through a deterministic IV.

## Consequences

- **Removal does not revoke history.** Old ciphertext stays in git. After a removal the secrets
  themselves must be rotated. `kit secrets rotate` is the existing path, and the removal command
  prints the list of keys to rotate.
- **Metadata is public.** File names, sizes, change times and the number of recipients are
  visible. The recipient stanzas carry no recipient name.
- **X25519 is not quantum resistant.** An attacker who keeps the ciphertext today can read it
  later if X25519 breaks. A hybrid recipient type is a later change, once `node:crypto` supports
  one. This is stated in the feature's documentation.
- **Scanners need a rule.** Secret scanning and `check-gitignore` must accept the format, and
  still flag any plaintext. `.env.keys`-style private keys stay a leak if tracked.
- **Open questions, to settle before accept:**
  - Where the pinned admin key lives (`~/.kit`, the OS keychain, or the vault).
  - Whether the manifest needs a protected-branch rule from `kit check`.
  - Per-value encryption (clean diffs and merges) against whole-file encryption (simple).
- **Enforcement.** No `kit-enforce` block fits, because the rules are behavioural. When
  accepted and implemented, `enforced_by:` must name tests for at least:
  - a manifest with fewer than two decryptable recipients is refused;
  - removal is refused if any file would lose all but one reader;
  - an unsigned or wrongly signed manifest is never used to wrap a key;
  - an unknown format version fails closed;
  - a tracked plaintext secret is still flagged.

## Sources

- age specification: https://github.com/C2SP/C2SP/blob/main/age.md
- git-crypt: https://github.com/AGWA/git-crypt
- GitHub rulesets and CODEOWNERS documentation (write and review controls only)
- kit: `src/memory/backup.ts`, `src/secret-backends.ts`, `src/check-gitignore.ts`
- the owner's request of 2026-11-21 that the feature must not lock anyone out
