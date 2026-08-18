# Releasing kit

How a kit release is cut, what the publish job refuses to publish, and the migration
away from a long-lived npm token. For the consumer side — verifying a release you did
not build — see [`docs/VERIFY.md`](./VERIFY.md).

## What a release is

One tag. `.github/workflows/publish.yml` triggers on `v*` and builds **the tree that tag
points at**, publishing 13 packages: the `sandstream-kit` CLI, `sandstream-kit-adapter-sdk`,
and the eleven `sandstream-kit-plugin-*` workspaces.

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

## Credentials: today

The publish steps authenticate with `NODE_AUTH_TOKEN` from the `NPM_TOKEN` secret, which is
scoped to the **`npm-publish` environment** rather than the repository. The token is
therefore released only after that environment's required-reviewer rule passes; configure
those reviewers in Settings → Environments, or the human gate does not exist.

## Credentials: the migration to trusted publishing

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

**The remaining work is registry-side and manual.** Each package is configured
individually on npmjs.com, and each can have exactly one trusted publisher at a time, so
this is 13 configurations:

| Package | | |
| --- | --- | --- |
| `sandstream-kit` | `sandstream-kit-adapter-sdk` | `sandstream-kit-plugin-cloudflare` |
| `sandstream-kit-plugin-fly` | `sandstream-kit-plugin-github` | `sandstream-kit-plugin-railway` |
| `sandstream-kit-plugin-sentrux` | `sandstream-kit-plugin-sentry` | `sandstream-kit-plugin-snyk` |
| `sandstream-kit-plugin-stripe` | `sandstream-kit-plugin-supabase` | `sandstream-kit-plugin-vercel` |
| `sandstream-kit-plugin-wiz` | | |

For each: Settings → Publishing access → add a GitHub Actions trusted publisher with
repository `sandstream/kit`, workflow `publish.yml`, and environment **`npm-publish`**.
Naming the environment is the part worth not skipping: it means only the reviewer-gated job
can mint a credential, where today the environment only protects the secret.

Two constraints to respect when the switch happens:

- **Do not move the publish behind `workflow_call`.** npm's validation reads the *calling*
  workflow's name, not the one that actually runs `npm publish`, so a reusable-workflow
  indirection breaks the check. `publish.yml` is triggered directly by the tag push today —
  keep it that way.
- **Self-hosted runners are not supported.** The job runs on `ubuntu-latest`
  (GitHub-hosted), which is.

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

Once every package is configured, the workflow change is a deletion: drop the
`NODE_AUTH_TOKEN`/`NPM_TOKEN` env from both publish steps (npm uses the token whenever it is
present, so OIDC only takes over once that env is gone — the two cannot both be in effect).
`id-token: write` is already granted. Keep a read-only granular token only if a private
dependency ever needs installing.

`--provenance` stays. Provenance is automatic under trusted publishing, so the flag is a
no-op there and leaving it in states the intent explicitly; if the first OIDC publish ever
rejects it, dropping it is a one-line follow-up. That is a deliberate choice not to change two
things at once in the release path.

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
