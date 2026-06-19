# kit threat model

> **Version 1.0 — 2026-06-08.** Updated when a new plugin, MCP integration, or
> data sink lands. The promises here are mechanical, not aspirational.

## What kit is

kit is a **CLI binary** that runs on the developer's machine (or a CI
runner). It reads project state from local files and makes API calls to vendor
services on the operator's behalf, using credentials the operator supplies. It
has no central server, no telemetry-by-default, and no background daemon.

If you trust your laptop and your vendor accounts, kit's added surface area
is small and bounded by this document.

## Trust boundaries

```
  [ developer's machine / CI runner ]                       [ external ]
  ┌──────────────────────────────────────────┐             ┌─────────────┐
  │                                          │             │             │
  │  .kit.toml         kit binary      │   HTTPS     │  vendor     │
  │  .env*           ───>  (CLI process)    │ ──────────> │  API        │
  │  .kit/                ↓               │   token     │  (Stripe,   │
  │                      plugin call         │  attached   │   Supabase, │
  │  vault (1P/inf.) ──>  reads token        │             │   Vercel,   │
  │                                          │             │   …)        │
  │  .kit-audit.jsonl  <── audit-log      │             │             │
  │                                          │             └─────────────┘
  └──────────────────────────────────────────┘
```

Everything inside the box stays inside the box unless an explicit per-call
config knob says otherwise.

## What kit reads

| Source | Purpose | Confidentiality |
|---|---|---|
| `.kit.toml` | Project declaration of tools / services / secrets refs | Plain text. Safe to commit — refs only, not values. |
| `.env*` | Plaintext secrets during development. Scanned, never echoed. | High — scanner truncates/redacts before log writes. |
| `.kit-audit.jsonl` | Local audit log. Append-only JSONL. | Medium — contains operation names + metadata but never secret values (sanitized via `redactSecrets()`). |
| Vault (1Password / Infisical / AWS-SM / GCP-SM / Azure-KV / Vault / Bitwarden / Doppler) | Secret values resolved on-demand via the vault's CLI/API | The vault stays the authority; kit only reads what an individual call needs. |
| `~/.kit/totp-secret` | TOTP seed for elevation | chmod 0o600; never sent over network. |
| `.kit/elevation.json` | Short-lived (default 15 min) elevation marker | Local only; deleted after `consumeElevation` for one-shot scopes. |

## What kit writes

| Destination | Trigger | Notes |
|---|---|---|
| `.kit.toml` | `secrets vault-migrate`, `init`, `analyze --write` | In-place TOML edit. Always re-readable. |
| `.env*` | `secrets migrate` cleanup | Default mode replaces value with blank (`KEY=`), preserving var-name visibility. |
| `.kit-audit.jsonl` | Every sensitive operation | Local append-only. |
| `.kit-skipped-commits.jsonl` | Post-commit detector fires | `git commit --no-verify` traces. |
| `.kit/elevation.json` | `auth elevate` | TTL'd marker. |
| Vault backend | `secrets migrate`, `rotate`, `vault-migrate`, `set-value` | Mediated by `writeSecretToBackend()` (`src/secrets-migrate.ts`). Read-only mode refuses here. |
| Vendor API (Stripe, Supabase, Vercel, GitHub, Fly, Cloudflare, Sentry) | Plugin write surfaces | Each plugin's write function calls `assertNotReadOnly()` and `appendAuditEventDirect()`. |
| `git` hooks under `.git/hooks/` | `hooks install` | Includes a sentinel writer + bypass detector. |

## What kit does NOT do

- **No central server.** kit publishes no agent, listens on no socket, has
  no SaaS dashboard. The CLI is the product.
- **No telemetry by default.** No anonymous usage data collected. If telemetry
  is ever added, it MUST be opt-in (see [out-of-scope](#out-of-scope)).
- **No cred caching outside the user vault.** Tokens fetched from 1P/Infisical
  exist only in the call's local memory; never persisted in a kit-owned
  database.
- **No background processes.** kit is a one-shot CLI. There is no daemon
  watching files, no scheduled poller, no IPC channel.
- **No automatic remote audit-log shipping.** `.kit-audit.jsonl` stays local.
  A remote audit sink is **opt-in** via `[audit].remote = true` (see
  `src/audit.ts`).
- **No secret values in error messages or logs.** Backend-write failures redact
  the held plaintext by exact substring before surfacing; `redactSecrets()`
  pattern-matching backs that up for values kit doesn't hold.
- **No shell-command allowlisting for agents.** kit gates its own writes
  (read-only mode) and destructive secret ops (elevation), and exports
  `KIT_POLICY_HASH` declaring the operator's pre-approved scopes — but it does
  not restrict which shell commands Claude Code / Codex / any agent may run.
  That enforcement lives in the agent host, which can honor the policy hash.
- **No interception of arbitrary installs.** `kit triage` and the pre-commit
  dependency check are verification gates you invoke (or wire as a hook); kit
  does not hook `npm`/`pip`/`docker` to block an un-triaged `npm install` an
  agent runs directly. Triage is a check to put in front of installs, not a
  kernel that intercepts them.

## Trust controls

### Read-only mode

`kit --read-only <subcommand>` activates a session-wide refusal of every
mutating operation. Honored by:

- `writeSecretToBackend()` (`src/secrets-migrate.ts`)
- `grantElevation()` (`src/elevation.ts`)
- `installHooks()` (`src/hooks.ts`)
- Every kit-plugin write surface (vercel/createEnvVar, stripe/createWebhookEndpoint, etc.) via inline `assertNotReadOnly()`

Operators who want the strongest guarantee can also set
`KIT_READ_ONLY=1` in their shell rc; the flag is honored by the same gate.

### Elevation gate

Destructive secret-ops require an interactive `kit auth elevate` followed by
a TOTP code (or yes-prompt fallback). The elevation marker has a 15-minute TTL
by default. One-shot scopes (`jwt-secret-roll`, `purge-history`, `onecli-register`)
are atomically consumed on first use.

CI escape hatch: `KIT_ELEVATED=1` bypasses the TTY requirement but emits a
loud `WARNING:` on stderr and writes an `elevation-check` audit event. If the
audit-log itself fails to write, the elevation is refused — never silent.

### Bypass detection

The pre-commit hook writes `.git/.kit-hook-ran`; the post-commit hook reads
it back. A missing sentinel means `git commit --no-verify` was used; the event
gets appended to `.kit-skipped-commits.jsonl` and a stderr banner appears on
the next `kit` invocation.

### Audit-log fail-closed

When `appendAuditEventDirect()` cannot write (disk full, perm error), the
calling operation refuses to proceed. The contract is: every destructive
operation MUST leave a forensic trail, or it MUST NOT run.

### Per-plugin authentication

Plugins receive tokens at call time from the resolved vault — never from a
plugin-owned config file. Tokens stay inside their `MgmtClient` struct for the
duration of one call; nothing persists beyond the await.

## Data residency

kit calls vendor APIs the operator already calls. kit adds **no extra
network hops**. If you trust Stripe and Vercel with your data, you trust the
same Stripe and Vercel endpoints when kit calls them.

The one exception is `[audit].remote = true` (off by default). When on,
audit-events are POST'd to a `KIT_REMOTE_URL` you configure. That URL is
yours — kit ships no default value.

## Reproducibility / supply chain

- Releases are published with `npm publish --provenance` (SLSA attestation).
- Git tags are GPG-signed.
- The dependency tree is bumblebee-scanned per release (see
  `.github/workflows/security.yml`).
- The published `kit` binary chmod's its dist artifacts to 0755 explicitly
  in `npm run build`; no runtime arbitrary-permission grants.

### Trusting the host toolchain (gcloud, brew, system CLIs)

kit pins and triages what **it** manages: mise-installed tools (versioned in
`.kit.toml`), project dependencies (`kit triage` before install, bumblebee per
release), and its own actions (SHA-pinned in CI). It does **not** verify CLIs you
install or update **outside** kit, and those are a separate supply chain worth
understanding:

- **`gcloud components update`** rests on TLS to Google's servers plus checksums
  in Google's own component manifest. That blocks an in-transit MITM and a
  corrupted download, but the checksum comes from the same manifest, so it is
  integrity *from Google*, not independent of Google. There is no GPG/Sigstore
  signature you pin. A friendly `Continue (Y/n)?` prompt confirms intent, not
  authenticity.
- **Homebrew** is a second supply chain (bottles from ghcr.io). Its tap-trust
  feature ignores formulae from untrusted taps by default; trust only the
  specific formula you need (`brew trust --formula <user>/<tap>/<formula>`),
  never a blanket trust.
- **`curl | sh` installers** fetch a moving target unless pinned to a release
  or commit.

How to harden host CLIs (kit cannot do this for you):

1. **Verify the first install.** Vendors publish a SHA256 for the initial
   download (Google for the gcloud SDK tarball, etc.). Verify it once; every
   later self-update inherits that binary's trust.
2. **Pin versions and keep rollback.** e.g. `gcloud components update --version X`
   is revertible. Reproducibility over "always latest".
3. **In CI, prefer the official container pinned by digest** (e.g.
   `google/cloud-sdk@sha256:...`) over an auto-updating CLI. Those images are
   attested and verifiable with `cosign verify`.
4. **Least privilege.** Never run a self-update as root; consider egress
   monitoring on dev machines.

The principle is the same one kit applies to npm/pip/docker (pin, verify,
reproduce); host CLIs just live outside kit's reach.

### `kit heal`: what auto-heal will and will not do

`kit heal` loops over `kit check` findings and applies fixes, within a fixed
contract that an autonomous agent cannot widen:

- **SAFE-AUTO** (applied without a gate): deterministic, reversible, with no
  credentials, outward writes, or history mutation. Installing a missing tool
  via mise, patching `.gitignore`, regenerating a lockfile, installing git
  hooks. These are the same primitives `kit setup`/`kit fix` already run.
- **GATED** (proposed, never auto-run by kit): secret rotation, git-history
  purge, deploy-target propagation, `npm audit fix`. heal prints the exact
  command; the human or agent runs it, and it still passes the existing
  `requireElevation` gate (TTL + HMAC-signed marker + TOTP/prompt) and is
  audit-logged. heal never calls elevation itself.
- **FAIL-CLOSED** (refused + alerted, never auto-healed): a supply-chain
  checksum mismatch is a possible tamper signal, so heal will not "fix" it
  (auto-clearing + re-downloading could mask an attack). It is surfaced loudly
  and heal exits non-zero. It does NOT block applying unrelated safe fixes (the
  tamper-suspect binary is never trusted or run, so an independent `.gitignore`
  patch is unaffected), but the mismatch itself stays a human decision.

So `kit heal --agent` can drive an environment toward green autonomously, yet it
can never rotate a secret, rewrite history, force-push, or trust a
checksum-mismatched binary on its own. zero-LLM: heal classifies + applies
deterministic fixers and emits proposals; the intelligence is the external
agent, not embedded in kit.

## Out of scope (and why)

- **LLM-router / orchestrator features.** kit is not Ruflo / Gas Town.
  Bringing those in would expand the trust surface significantly. See plan
  history for the rejection rationale.
- **Plugin marketplace storage.** Reviews / star ratings / etc. are not part
  of the trust model.
- **Telemetry collection.** Even opt-in. Out until a clear use-case justifies
  the privacy cost.

## Reporting

Security issues: file a GitHub security advisory at
https://github.com/sandstream/kit/security/advisories. Until then, email
hello@sandstre.am with `[kit-security]` in the subject.
