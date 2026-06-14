# Verifying a kit release

kit publishes signed artifacts. This doc shows you exactly how to verify a
release before trusting it on a developer machine, a CI runner, or a
production-adjacent workflow. Every step is reproducible from public data.

## What ships per release

When `v<N>.<N>.<N>` is tagged on `main`:

1. **npm tarball** — published to `npmjs.com/package/sandstream-kit` with
   `npm publish --provenance`. SLSA Level 3 build provenance attestation is
   automatically generated, signed by the GitHub Actions OIDC identity, and
   uploaded to Sigstore's public transparency log.
2. **GitHub artifact attestation** — independent of npm provenance, attaches
   a signed manifest of the built `dist/` tree to the GitHub release.
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
| `gh attestation verify` | Cross-checks against the GitHub build — catches divergence between npm-side and source-of-truth |
| `git tag -v` | Tag-rewrite attacks; ensures the commit you check out is what the maintainer published |
| SBOM scan | Known-vulnerable transitive deps; license-policy violations |

All four together = SLSA Level 3 supply-chain guarantee. The build is
reproducible from source, the build platform is signed, and the artifact is
attested at multiple independent points.

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
- name: Verify kit attestation
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    npm pack sandstream-kit@$KIT_VERSION
    gh attestation verify \
      --owner sandstream \
      --repo kit \
      sandstream-kit-$KIT_VERSION.tgz
    npm install -g ./sandstream-kit-$KIT_VERSION.tgz
```

This ensures the CI runner only installs versions that pass attestation
verification — refusing tarballs that don't match the published build.

## Reporting verification problems

If `npm audit signatures` reports `invalid` or `gh attestation verify`
fails, **do not install or run the binary**. File a security advisory at
https://github.com/sandstream/kit/security/advisories or email
hello@sandstre.am with `[kit-security]` in the subject. Include the
exact version + the verification output.
