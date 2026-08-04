# Verifying a kit release

kit publishes signed artifacts. This doc shows you exactly how to verify a
release before trusting it on a developer machine, a CI runner, or a
production-adjacent workflow. Every step is reproducible from public data.

## What ships per release

When `v<N>.<N>.<N>` is tagged on `main`:

1. **npm tarball** — published to `npmjs.com/package/sandstream-kit` with
   `npm publish --provenance`. A SLSA build-provenance attestation is
   automatically generated, signed by the GitHub Actions OIDC identity, and
   uploaded to Sigstore's public transparency log.
2. **GitHub artifact attestation** — independent of npm provenance, attaches a
   signed provenance statement for the published tarball to this repo's
   attestation store. **Not present on releases up to and including 6.3.1** —
   see the note below before relying on it.
3. **CycloneDX SBOM** (`sbom.cyclonedx.json`) — full dependency-tree
   inventory in the format US EO 14028 / EU CRA expect.
4. **SPDX SBOM** (`sbom.spdx.json`) — same, in the SPDX 2.3 format some
   federal/RHEL consumers prefer.
5. **Signed git tag** — GPG-signed annotated tag on the publish commit.
   Verify with `git tag -v v<N>.<N>.<N>`.

## How to verify before installing

### Verify the npm tarball (recommended for everyone)

```bash
# 1. Pull the tarball without installing
npm pack sandstream-kit@<version>

# 2. Verify the SLSA provenance attestation
npm audit signatures

# Expected output: "audited <N> packages in <X>s — N issues" with
# "1 package has a verified registry signature" for sandstream-kit
```

The `npm audit signatures` command checks two things:
- Registry signature (every npm package since Apr 2024)
- Provenance attestation (only packages published with `--provenance`)

Both must be `verified` for the version you want to install.

### Verify the GitHub artifact attestation (defense-in-depth)

```bash
# Requires gh-cli (https://cli.github.com)
gh attestation verify \
  --owner sandstream \
  --repo kit \
  sandstream-kit-<version>.tgz
```

`gh attestation verify` cross-checks against the `actions/attest-build-provenance`
step in `.github/workflows/publish.yml`. If the binary's hash differs from
what the workflow built, the command fails.

> **This returns "no attestations found" for every release up to and including
> 6.3.1, and that is our bug, not a tampering signal.** The step passed
> `subject-path: dist/**/*` — 1920 files against the action's hard limit of 1024 —
> so it errored in 327ms with `Too many subjects specified (>1024)` on every
> release. `continue-on-error: true` (there to stop a Sigstore hang from
> stranding an already-published release) then reported the step as SUCCESS to
> the jobs API while the log said failure, so nothing surfaced it. Measured in
> run `30804371457`, step 20.
>
> Fixed for the next release: the step now attests the packed tarball — one
> subject, and the same bytes npm published — and a following step annotates the
> run and the job summary whenever the attestation did not happen, so a
> swallowed failure can no longer read as green.
>
> Until then, verify 6.3.1 with the **npm provenance** above (that one is real:
> its attestation carries a `slsa.dev/provenance/v1` statement with the GitHub
> Actions workflow buildType) plus the **signed git tag**. Two independent
> checks, not three.

### Verify the signed git tag

```bash
git clone https://github.com/sandstream/kit
cd kit
git tag -v v<version>
```

Expected output:
```
gpg: Signature made <timestamp>
gpg:                using <KEY-TYPE> key <KEY-ID>
gpg: Good signature from "<MAINTAINER>" [<TRUST>]
```

Import the maintainer's public key once:
```bash
gh api /users/sandstream/gpg_keys --jq '.[0].raw_key' | gpg --import
```

### Verify the SBOM (auditor-only)

```bash
# Download CycloneDX SBOM from the GitHub release
gh release download v<version> --pattern sbom.cyclonedx.json

# Inspect with grype / trivy / your scanner of choice
grype sbom:sbom.cyclonedx.json
trivy sbom sbom.cyclonedx.json
```

The SBOM lists every transitive dep with its resolved version and license.
If your supply-chain policy bans a specific package or license, this is the
artifact you scan against.

## What "verified" buys you

| Verification | Catches |
|---|---|
| `npm audit signatures` | Tarball tampering after publish; registry compromise |
| `gh attestation verify` | Cross-checks against the GitHub build — catches divergence between npm-side and source-of-truth. **Nothing to check on ≤6.3.1** (see the note above) |
| `git tag -v` | Tag-rewrite attacks; ensures the commit you check out is what the maintainer published |
| SBOM scan | Known-vulnerable transitive deps; license-policy violations |

What these four do NOT add up to is a SLSA level. SLSA levels are defined on the
build/provenance track: L3 asks for a hardened build platform producing
non-falsifiable provenance, which `npm publish --provenance` from a GitHub-hosted
runner does supply — verified for 6.3.1, whose npm attestation carries a
`slsa.dev/provenance/v1` statement with the GitHub Actions workflow buildType. The
other three rows are CONSUMER-side verifications. They are worth running, and they
do not raise a level.

And this paragraph previously claimed "the build is reproducible from source". It is
not, and SLSA does not ask for it at any level (reproducible builds are explicitly out
of scope in SLSA v1.0). kit has no reproducible-build proof — no build-timestamp
normalisation, no rebuild-and-compare in CI. Do not cite kit as reproducible.

Honest summary of what the four buy you: the artifact you install is the one that was
published (signatures), it was built by this repo's workflow from a signed tag
(provenance + `git tag -v`), and its dependency tree is enumerated for scanning (SBOM).
That is a strong chain. It is not a reproducibility claim and not a certified level.

## What kit explicitly does NOT do

- **No auto-update.** kit never silently upgrades itself. You install /
  upgrade via `npm install -g sandstream-kit@<version>`. If you didn't run
  that, the binary on your machine is the binary you last verified.
- **No phone-home version-check.** kit doesn't ping a remote endpoint to
  see if a newer version exists. `npm outdated` is the only mechanism.
- **No telemetry on verification failure.** If `npm audit signatures` fails,
  kit (the CLI) is never notified. You decide what to do.

## CI-side verification

For organizations that pin kit in CI:

```yaml
# .github/workflows/kit-pin.yml
- name: Verify kit before installing
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    set -euo pipefail
    npm pack "sandstream-kit@$KIT_VERSION"
    # Gate 1 — npm provenance. Present on every release; blocking.
    npm audit signatures
    # Gate 2 — GitHub attestation. Absent on <=6.3.1 (see the note above), so it
    # ADVISES rather than blocks; make it blocking once you pin a later version.
    gh attestation verify \
      --owner sandstream \
      --repo kit \
      "sandstream-kit-$KIT_VERSION.tgz" \
      || echo "::warning::no GitHub attestation for $KIT_VERSION — npm provenance still verified above"
    npm install -g "./sandstream-kit-$KIT_VERSION.tgz"
```

The npm-provenance gate is the blocking one: the runner installs only a tarball
whose signature matches the published build. The attestation gate is written
non-blocking on purpose — pointing a hard gate at something kit did not ship
until after 6.3.1 would fail every pinned build for a reason that has nothing to
do with the artifact. Flip the `||` away once your pinned version has one.

## Reporting verification problems

If `npm audit signatures` reports `invalid` or `gh attestation verify`
fails, **do not install or run the binary**. File a security advisory at
https://github.com/sandstream/kit/security/advisories or email
hello@sandstre.am with `[kit-security]` in the subject. Include the
exact version + the verification output.
