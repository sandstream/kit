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
   attestation store. **Present from 6.3.2 onward**; releases up to and
   including 6.3.1 have none (see the note below).
3. **CycloneDX SBOM** (`sbom.cyclonedx.json`) — inventory Syft derives from
   the extracted `sandstream-kit` npm tarball. It does not scan the repository
   checkout or the separately published plugin tarballs.
4. **SPDX SBOM** (`sbom.spdx.json`) — the same root-tarball scan in SPDX 2.3
   format. The root tarball has no installed `node_modules`, so these files
   should not be treated as a complete transitive dependency inventory.
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
gh attestation verify sandstream-kit-<version>.tgz --repo sandstream/kit
```

`--repo` takes the full `owner/repo`. `--owner sandstream --repo kit` fails with
`invalid value provided for repo: kit` — the two flags are alternatives, not a
pair, and `--owner sandstream` alone also works.

`gh attestation verify` cross-checks against the `actions/attest-build-provenance`
step in `.github/workflows/publish.yml`. If the binary's hash differs from
what the workflow built, the command fails.

Success is exit 0. For a scriptable result add `--format json`: the statement
carries `predicateType: https://slsa.dev/provenance/v1`, exactly **one**
`subject` whose `digest.sha256` is the tarball you passed in, and a
`buildSignerURI` naming the workflow and tag that built it. Measured for 6.3.2,
against a tarball fetched from the registry whose sha512 equals npm's own
`dist.integrity`:

```
subjects:         1
subject name:     sandstream-kit-6.3.2.tgz
digest sha256:    de2f6328c5023323d1836b7fe40abf6e0e28d98334166631a49f43f7183c85dd
buildSignerURI:   …/sandstream/kit/.github/workflows/publish.yml@refs/tags/v6.3.2
runInvocationURI: …/sandstream/kit/actions/runs/30890753307/attempts/1
```

> **Releases up to and including 6.3.1 have no attestation, and that is our bug,
> not a tampering signal.** The step passed `subject-path: dist/**/*` — 1920
> files against the action's hard limit of 1024 — so it errored in 327ms with
> `Too many subjects specified (>1024)` on every release, while
> `continue-on-error: true` (there to stop a Sigstore hang from stranding an
> already-published release) reported the step to the jobs API as SUCCESS.
> Measured in run `30804371457`, step 20. If you pin `<=6.3.1`, verify with the
> **npm provenance** above plus the **signed git tag**: two independent checks,
> not three.

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

> **`v6.6.3` is unsigned — known, and not retroactively fixable.** The publish job's
> signature gate ran its check inside a pipe (`if ! git verify-tag … | tee …`), so the
> pipeline reported `tee`'s always-zero exit and the gate never fired; `v6.6.3` was tagged
> with `git tag -a` and published anyway, with every GPG pin around it intact and useless.
> `git tag -v v6.6.3` therefore prints `error: no signature found`. Re-signing would mean
> force-pushing a published tag, which re-triggers the publish workflow against a version
> already on the registry — so the tag stands as it is and this note records why. The gate
> was fixed in 6.6.4 (`set -o pipefail` plus a redirect instead of the pipe), is asserted by
> `src/publish-workflow.test.ts`, and the pattern is now caught repo-wide by self-audit
> `R1-fail-open-ci`. `v6.6.4` onward is signed; verify it as above. Every other control on
> `v6.6.3` — npm provenance, the registry signature, both SBOMs — is unaffected and
> verifiable.

### Verify the SBOM (auditor-only)

```bash
# Download CycloneDX SBOM from the GitHub release
gh release download v<version> --pattern sbom.cyclonedx.json

# Inspect with grype / trivy / your scanner of choice
grype sbom:sbom.cyclonedx.json
trivy sbom sbom.cyclonedx.json
```

The SBOM lists components Syft detects in the extracted root tarball. It does
not establish a complete installed dependency tree or describe the separate
plugin packages. Scan it for package contents and detected components; assess
installed transitive dependencies separately.

## What "verified" buys you

| Verification            | Catches                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm audit signatures`  | Tarball tampering after publish; registry compromise                                                                                                                              |
| `gh attestation verify` | Cross-checks against the GitHub build — catches divergence between npm-side and source-of-truth. Available from **6.3.2** onward; nothing to check on ≤6.3.1 (see the note above) |
| `git tag -v`            | Tag-rewrite attacks; ensures the commit you check out is what the maintainer published                                                                                            |
| SBOM scan               | Vulnerabilities or license-policy violations among detected components of the root tarball                                                                                        |

These four checks do not certify a SLSA level. npm provenance and the optional
GitHub artifact attestation identify the build workflow and artifact digest;
they are evidence for assessing a release, not a substitute for assessing the
build platform and its controls. The other rows are consumer-side checks.

And this paragraph previously claimed "the build is reproducible from source". It is
not, and SLSA does not ask for it at any level (reproducible builds are explicitly out
of scope in SLSA v1.0). kit has no reproducible-build proof — no build-timestamp
normalisation, no rebuild-and-compare in CI. Do not cite kit as reproducible.

Together, the signatures identify the published tarball, provenance identifies
the workflow and tag, and the SBOM inventories components detected in the root
tarball. This is neither a reproducibility claim nor a certified SLSA level.

## Update and telemetry boundaries

- **No automatic update by default.** Normal interactive commands may perform a cached version
  check against the npm registry and print an available-update notice. Disable it with
  `[update].check = false`, `KIT_NO_UPDATE_CHECK=1`, CI mode, or air-gap mode. An actual self-update
  happens only through explicit `kit upgrade --self`, or the explicit opt-in
  `[update].auto = true`; both paths triage the package before installation and surface the action.
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
    # Gate 2 — GitHub attestation. Blocking from 6.3.2 onward. If you pin
    # <=6.3.1 there is nothing to check (see the note above): drop this gate
    # rather than letting it advise, so a green run never means "unchecked".
    gh attestation verify "sandstream-kit-$KIT_VERSION.tgz" --repo sandstream/kit
    npm install -g "./sandstream-kit-$KIT_VERSION.tgz"
```

Both gates block, and `set -euo pipefail` means either one stops the install.
That is the point: the runner installs only a tarball whose signature matches
the published build AND whose digest the source repo attests to.

Gate 2 was written non-blocking until 6.3.2, because pointing a hard gate at
something kit had never actually shipped would have failed every pinned build
for a reason that had nothing to do with the artifact. It ships now — verified
against 6.3.2, one subject, digest equal to the bytes npm serves — so the gate
blocks. The `|| echo "::warning::…"` that used to soften it is gone on purpose:
a warning in a CI log is indistinguishable from a passing check to everyone who
is not reading the log.

## Reporting verification problems

If `npm audit signatures` reports `invalid` or `gh attestation verify`
fails, **do not install or run the binary**. File a security advisory at
https://github.com/sandstream/kit/security/advisories or email
hello@sandstre.am with `[kit-security]` in the subject. Include the
exact version + the verification output.
