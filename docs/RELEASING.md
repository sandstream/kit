# Releasing kit

How a kit release is cut, what the publish job refuses to publish, and the migration
away from a long-lived npm token. For the consumer side — verifying a release you did
not build — see [`docs/VERIFY.md`](./VERIFY.md).

## What a release is

One tag. `.github/workflows/publish.yml` triggers on `v*` and builds **the tree that tag
points at**, publishing 14 packages: the `sandstream-kit` CLI, `sandstream-kit-adapter-sdk`,
and the twelve `sandstream-kit-plugin-*` workspaces.

Because the tag's tree is what ships, the tag goes on the commit whose `package.json` and
`CHANGELOG.md` describe the release — not on whatever `main` happens to be. When feature
work merges after the release-prep commit, that work waits for the next version rather
than shipping under a version whose changelog does not mention it.

```bash
# 1. Prepare: bump package.json, write the CHANGELOG section, merge that PR.
# 2. Tag the prep commit itself (signed — the job verifies the signature):
git tag -s v6.6.4 <prep-commit> -m "v6.6.4 — <one line>"
git push origin v6.6.4
# 3. Approve the `npm-publish` environment when GitHub asks.
```

## What the job refuses to publish

Each of these fails the release rather than shipping something unverifiable:

- the tag does not match `package.json`'s version;
- `CHANGELOG.md` has no section for that version (checked **before** the publish, so an
  undocumented release aborts while aborting is still free);
- the tag is unsigned, or signed by a key whose fingerprint is not the one pinned in the
  `MAINTAINER_KEY_FPR` secret (the in-repo public key alone is not trusted — a tag pusher
  could swap it);
- `npm audit --audit-level=high` finds a high CVE;
- the bumblebee supply-chain catalog matches anything, **or could not run**;
- the test suite fails, or the production build fails;
- a plugin's `sandstream-kit-adapter-sdk` peer range does not admit the SDK version being
  published, or the SDK major has drifted off its frozen `1.x` contract.

A prerelease version (any `-` identifier) publishes under the `next` dist-tag, so `latest`
only ever moves on a stable release.

## Credentials: trusted publishing (no npm token)

There is no npm token in this repository any more. The packages that shipped before
`sandstream-kit-plugin-aisle` carry a GitHub Actions trusted publisher naming
`sandstream/kit`, the workflow file `publish.yml`, and the environment `npm-publish`,
with the single permission `npm publish` (not staged publish — least privilege).
`sandstream-kit-plugin-aisle` needs the same npm-side Trusted Publisher setup before
the first release that includes it. The job exchanges its OIDC identity for a
short-lived credential, so the environment is part of the credential rather than
merely the guard around a secret:
configure required reviewers on `npm-publish` in Settings → Environments, or the human gate
does not exist.

Two constraints keep it working:

- **Keep the publish job triggered directly by the tag push.** npm's validation reads the
  *calling* workflow's name, so putting the publish behind `workflow_call` breaks the check.
- **Never re-add `NODE_AUTH_TOKEN`.** npm prefers a token whenever one is present, so adding
  one silently moves publishing back onto the credential npm is retiring.
  `src/publish-workflow.test.ts` fails if any executing line in the workflow carries one.

`--provenance` stays on the publish commands. Provenance is automatic under trusted
publishing, so the flag is a no-op there and states the intent explicitly.

**Token publishing is disallowed** (2026-08-19, after 6.6.5-rc.1 proved the OIDC path). Every
package's "Publishing access" is set to *require two-factor authentication and disallow bypass
2fa tokens*, which is what turns "we also have OIDC" into "only OIDC can publish". Each
setting was read back from its own settings page.

Consequences worth knowing before the next release:

- **There is no token fallback left.** If a package's trusted publisher is misconfigured, its
  publish step fails and the fix is to correct the publisher in npm's UI — not to publish with
  a token. The workspace loop is idempotent, so re-running the job after the fix completes the
  set.
- **The CLI path for these settings needs TOTP.** `npm access set mfa=publish <pkg>` sets the
  same thing without the web UI, but it returns `EOTP` and `--otp=<code>` needs an
  authenticator app. A security-key-only account cannot use it, and npm does not offer adding
  TOTP alongside an existing security key — only disabling 2FA and re-enrolling, which is not
  worth doing for this.
- **npm's step-up 2FA is flaky under repetition.** Expect saves to hang on "Verifying…" or
  return "Something went wrong. Please try again later." Nothing half-saves; re-select the
  radio and submit again. Select the value FIRST and submit only when you are ready to touch
  the key — the prompt expires in about a minute, and `Update Package Settings` does nothing at
  all if the radio has not actually changed.

## Background: why the migration happened

npm is retiring 2FA-bypass granular access tokens as a publishing credential:

| Phase | When | Effect |
| --- | --- | --- |
| 1 | ~August 2026 | such a token no longer skips 2FA for sensitive operations (token create/delete, package access, maintainer/org/team changes). Publishing still works. |
| 2 | ~January 2027 | such a token **cannot publish directly**. It can read private packages and *stage* a publish for human 2FA approval. |

The migration target is **trusted publishing**: GitHub Actions exchanges its OIDC identity
for a short-lived credential, so there is no long-lived npm secret in the repository at all.

**Prerequisite, already in place.** Trusted publishing exists only in **npm ≥ 11.5.1** on
**node ≥ 22.14.0**. `actions/setup-node` ships npm 10.9.x for node 22, so the job installs
`npm@^11.5.1` explicitly before doing anything else. `src/publish-workflow.test.ts` asserts
that step exists, pins a high-enough version, and runs before any publish — a comment cannot
fail CI, and a publish job runs only on a tag push, the worst moment to discover a too-old
client.

**The registry-side work is done for the pre-AISLE packages** (2026-08-19): every
package below was configured and its saved connection read back from its own settings
page. The list is kept because a NEW package needs the same treatment before its first
release — no token exists to fall back on.

| Package | | |
| --- | --- | --- |
| `sandstream-kit` | `sandstream-kit-adapter-sdk` | `sandstream-kit-plugin-cloudflare` |
| `sandstream-kit-plugin-fly` | `sandstream-kit-plugin-github` | `sandstream-kit-plugin-railway` |
| `sandstream-kit-plugin-sentrux` | `sandstream-kit-plugin-sentry` | `sandstream-kit-plugin-snyk` |
| `sandstream-kit-plugin-stripe` | `sandstream-kit-plugin-supabase` | `sandstream-kit-plugin-vercel` |
| `sandstream-kit-plugin-wiz` | | |

`sandstream-kit-plugin-aisle` is intentionally not in the verified list yet. Configure
its npm Trusted Publisher before the release that first publishes it, then move it into
the verified table in that same release-prep PR.

For each (and for any new package): its npm page → Settings → Trusted Publisher → GitHub
Actions, then `Organization or user` = `sandstream`, `Repository` = `kit`,
`Workflow filename` = `publish.yml` (filename only, no path), `Environment name` =
`npm-publish`, `Allowed actions` = `npm publish` only. Naming the environment is the part
worth not skipping: it is what limits credential minting to the reviewer-gated job.

npm requires step-up 2FA (security key) to save each one, and it does NOT keep the session
elevated — expect one key tap per package, and expect a save to be lost if the prompt times
out. Nothing half-saves, so a retry is free. Rapid automation of the UI also trips
Cloudflare's bot check, which only a human can clear.

Self-hosted runners are not supported by trusted publishing; this job runs on
`ubuntu-latest`, which is.

**`scripts/trusted-publishing-wizard.sh` walks all of it.** It derives the package list from
this repo rather than carrying a copy (a hardcoded list drifts the moment someone adds a
plugin, and a *missed* package is the one failure this migration must not have: no token and
no trusted publisher means that package's publish step fails), records what you confirm in
`.kit/trusted-publishing.state` so you can stop and resume, refuses to remove the token until
every package is recorded, and ends by pointing at a prerelease as the only honest test. Run
it from the repo root:

```bash
./scripts/trusted-publishing-wizard.sh
```

It cannot verify the npmjs.com side for you — `npm access` on npm 11.19.0 covers
status/collaborators/grant/revoke and has no read or write path for a trusted publisher, so
the setting exists only in the web UI. What the wizard verifies is everything else: the
workflow file, the npm client floor, the environment's existence, and the package list.

The workflow change that followed was a deletion: `NODE_AUTH_TOKEN` is gone from both publish
steps, and `id-token: write` was already granted. Keep a read-only granular token only if a
private dependency ever needs installing. If the first OIDC publish ever rejects
`--provenance`, dropping that flag is a one-line follow-up — kept deliberately so the release
path changed one thing, not two.

**Prove it with a prerelease, not with the next real version.** publish.yml routes any version
containing a hyphen to the `next` dist-tag, so `latest` does not move. Bump to
`X.Y.Z-rc.1`, give it its own `## [X.Y.Z-rc.1]` CHANGELOG section (the job refuses to publish
a version the changelog does not document, and it checks that *before* publishing), tag the
release commit signed, and push. If one package fails with 404/403, its trusted publisher is
missing or its fields do not match — the workspace loop is idempotent, so fix that package and
re-run the job; the ones already published are skipped.

Verify the first OIDC release the same way as any other: `npm view sandstream-kit version`,
install the published tarball and run its binary, and confirm both SBOMs are attached to the
GitHub release. `npm audit signatures` should still report a verified registry signature and
provenance.

## After the release

- Confirm the published version really runs, not merely that the job was green:
  `npm i sandstream-kit@<version>` in a scratch directory, then `kit --version`.
- Check the GitHub release carries `sbom.cyclonedx.json` and `sbom.spdx.json`.
- If the attest step warned, the release has npm provenance but no GitHub artifact
  attestation — `gh attestation verify` will find nothing for it. That is a warning, not a
  failed release, and it is worth re-running rather than leaving silently unattested.
