# Running kit in an air-gapped / no-egress environment

kit is local-first and makes **zero LLM calls and no telemetry**, so it already
fits a restricted enclave. The one place the default configuration reaches the
public internet is the **triage gate**, which queries package registries to
evaluate a target before install. In an air-gapped network you point those
queries at your **internal mirrors** instead, and run the heavy scanners against
**local databases**. Nothing else phones home.

> Fail-closed by design: if a registry/mirror is unreachable, triage records a
> CRITICAL ("cannot verify") and withholds `TRIAGE PASSED`, so kit **blocks** the
> install rather than waving it through. Point the endpoints at reachable
> internal mirrors so triage can actually evaluate targets.

## Declarative config (recommended)

Everything below can be set with `KIT_*` env vars **or** checked into
`.kit.toml` so the enclave posture is reproducible and versioned. Env vars
override the file when both are set.

```toml
[air_gap]
enabled = true                                   # turns on offline scan mode
npm_registry = "https://npm.corp.internal"
pypi_index = "https://pypi.corp.internal"
github_api = "https://ghe.corp.internal/api/v3"
docker_registry = "https://registry.corp.internal"
threat_data_dir = "/opt/kit/threat-data"
threat_data_pubkey = "/etc/kit/threat-data.pub"
```

## 1. Point the triage gate at internal mirrors

The triage script reads its registry hosts from the environment, defaulting to
the public registries. Set these (in the shell, CI job, or the environment kit
runs under) to your internal mirrors:

| Env var               | Default                      | Used for                                                                 |
| :-------------------- | :--------------------------- | :----------------------------------------------------------------------- |
| `KIT_NPM_REGISTRY`    | `https://registry.npmjs.org` | npm package metadata (`kit triage npm:…`)                                |
| `KIT_PYPI_INDEX`      | `https://pypi.org`           | PyPI metadata (`pip:…`); expects `/pypi/<name>/json`                     |
| `KIT_GITHUB_API`      | `https://api.github.com`     | repo metadata (`repo:…`, `skill` fallback) — GitHub Enterprise API base  |
| `KIT_DOCKER_REGISTRY` | `https://hub.docker.com`     | image metadata (`docker:…`); expects the `/v2/repositories/<repo>` shape |

The mirror must expose the same JSON shapes as the upstream it mirrors (most
internal npm/PyPI proxies and GitHub Enterprise do). The package/repo name is
the only attacker-influenceable part and is only ever interpolated into the URL
_path_ — the host comes from these operator-set vars, never from the target.

```bash
export KIT_NPM_REGISTRY="https://npm.corp.internal"
export KIT_PYPI_INDEX="https://pypi.corp.internal"
export KIT_GITHUB_API="https://ghe.corp.internal/api/v3"
export KIT_DOCKER_REGISTRY="https://registry.corp.internal"
kit triage npm:left-pad      # now evaluated against the internal mirror
```

## 2. Run the scanners locally / offline

Set **`KIT_AIRGAP=1`** and `kit scan` switches to offline mode: it drops
cloud-only scanners and folds each remaining scanner's offline flags/env in so it
runs against a **pre-synced local DB with no network**.

```bash
export KIT_AIRGAP=1
kit scan      # → "air-gap mode: offline scanners only (skipping cloud-only: snyk, semgrep)"
```

What the mode does per scanner:

| Scanner         | Air-gap behavior                                                                                                                                              |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **trivy**       | adds `--offline-scan --skip-db-update` (pre-sync the DB on a connected host with `trivy --download-db-only`, or point `TRIVY_DB_REPOSITORY` at an OCI mirror) |
| **grype**       | sets `GRYPE_DB_AUTO_UPDATE=false` (provide a cached DB via `GRYPE_DB_CACHE_DIR`, synced with `grype db update` on a connected host)                           |
| **osv-scanner** | adds `--offline` (point at a synced local OSV DB)                                                                                                             |
| **snyk**        | **skipped** — talks to the Snyk cloud                                                                                                                         |
| **semgrep**     | **skipped** — `--config auto` fetches the registry (local-ruleset support is a tracked follow-up)                                                             |

Install the scanners through your internal package mirror or an approved binary
cache; kit never downloads them itself.

### Verified offline threat-data bundle (signed)

Stale or tampered threat data silently degrades every verdict. To give the
sync-in a trust chain that is **fully offline-verifiable** (no Fulcio/Rekor),
ship the DBs as a _signed bundle_ and point kit at it:

```bash
export KIT_AIRGAP=1
export KIT_THREAT_DATA_DIR=/opt/kit/threat-data
export KIT_THREAT_DATA_PUBKEY=/etc/kit/threat-data.pub   # PEM (path or inline)
kit scan
```

The bundle dir contains:

- `manifest.json` — `{ version, artifacts: [{ path, sha256, env? }] }`
- `manifest.json.sig` — a base64 **Ed25519** signature over `manifest.json`, made
  on the connected host with the key whose public half is `KIT_THREAT_DATA_PUBKEY`
- the artifacts themselves (e.g. `grype.db`, `osv.db`, a bumblebee catalog)

kit verifies the manifest **signature**, then the **SHA-256** of every artifact,
then sets each artifact's declared `env` var to its absolute path (e.g.
`GRYPE_DB_CACHE_DIR`) so the scanner uses the verified local DB. **Any failure —
bad signature, checksum mismatch, missing/extra-path artifact — rejects the whole
bundle and `kit scan` refuses to run (fail-closed).** The bundle author declares
the `env` wiring per artifact, so kit hard-codes no scanner-version specifics.

Build the bundle on a connected host (sync DBs → write manifest with SHA-256 →
`openssl pkeyutl -sign` / equivalent Ed25519 signing), then transfer it in.

## 3. Bumblebee (known-compromise scan) offline

- `KIT_BUMBLEBEE_BIN` — use a pre-installed, internally-vetted bumblebee binary
  instead of letting kit fetch the pinned release from GitHub.
- `KIT_BUMBLEBEE_CATALOG` — point at an internally-mirrored exposure catalog.
- `KIT_BUMBLEBEE=0` — disable the download/scan entirely where policy forbids it.

## 4. Offline provenance verification

cosign/SLSA verification normally reaches Sigstore's Fulcio CA + Rekor log
(public). `kit verify-provenance` runs cosign **fully offline** instead: it uses
the bundle's inclusion proof (`--offline`) and a **shipped-in** Sigstore
`trusted_root.json` (`--trusted-root`) that you distribute and refresh into the
enclave — no Fulcio/Rekor egress. kit does not reimplement the crypto; it
orchestrates cosign and is **fail-closed** (missing cosign, missing trust root,
missing identity constraints, or any non-zero cosign exit ⇒ NOT verified).

```bash
kit verify-provenance dist/app.tar.gz \
  --bundle dist/app.sigstore \
  --trusted-root /etc/kit/trusted_root.json \
  --identity "https://github.com/org/repo/.github/workflows/release.yml@refs/tags/v1" \
  --issuer  "https://token.actions.githubusercontent.com"
```

Defaults for `--trusted-root` / `--identity` / `--issuer` can live in
`.kit.toml [air_gap]` (`provenance_trusted_root` / `provenance_cert_identity` /
`provenance_cert_issuer`) or the matching `KIT_PROVENANCE_*` env vars, so the
command is just `kit verify-provenance <artifact> --bundle <file>`.

**Operational note:** the enclave owner is responsible for distributing and
periodically refreshing `trusted_root.json` (a TUF mirror snapshot or pinned
roots) from a connected host — that is the trust anchor for offline
verification.

## What still never leaves the enclave

Secret resolution, the memory store, the audit log, `kit check`/`review`
verdicts, agent/MCP config and GitHub-Actions auditing, and SBOM generation are
all fully local and make no network calls regardless of the settings above.
