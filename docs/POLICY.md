# Policy-as-code (`kit policy`)

> Experimental (3.0 Phase 1). The signable org **standard**, distinct from project
> config and from the 2.x agent-write pre-approval.

kit 3.0's model-change is that the **standard** becomes a first-class, signable
document an org owns — separate from per-project config — that a `kit identity`
signs and any kit can verify offline before enforcing. "identity + policy = the
contract."

## The document: `.kit-policy.toml`

```toml
version = 1

require_triage = true                      # no untriaged dependency installs
required_scanners = ["trivy", "trufflehog"] # these MUST run; a missing one fails the gate
prod_writes_need_approval = true
min_kit_version = "2.2.0"

[thresholds]
code_health = 7.5                          # e.g. CodeScene
```

`kit policy init` scaffolds it. `kit policy validate` checks it against the
allow-listed schema. `version` is required and a doc declaring a version newer than
this kit understands is refused (upgrade kit).

## Signing + verification

```
kit policy sign            # sign with this machine's kit identity → .kit-policy.sig
kit policy verify          # verify against locally-known keys (current + rotated)
kit policy verify --key <spki-pem|file>   # pin the expected org key
```

- Signing is over **canonical JSON** (recursively key-sorted) of the parsed
  document, so the signature survives TOML reformatting, comments, and key
  reordering — it breaks only on a **real policy change**.
- `kit policy sign` refuses to sign an invalid policy (a signature must vouch for a
  sound doc).
- `verify` fails if the policy changed since signing (fingerprint mismatch) or the
  signature is invalid; it **fail-opens** (a warning, not a failure) when the
  signer key is unknown — pin it with `--key`. A signature by a **revoked** key
  (see `kit panic`) fails.

Commit both `.kit-policy.toml` and `.kit-policy.sig`; they travel with the repo,
and an org distributing one signed policy across many repos verifies the same way
everywhere.

## Not the same as `[policy.agent_writes]`

`.kit.toml [policy.agent_writes]` (2.x, see `src/policy.ts`) is the **per-repo
agent-write pre-approval** — which vendor operations the operator pre-authorized.
`.kit-policy.toml` is the **org-level standard** (thresholds / requirements),
versioned and signed independently of project config. They are complementary
layers.

## What's next

This slice ships the signable document + sign/verify. The enforcement glue —
`kit check` / `kit ci` reading the policy and reporting/gating against it — is the
follow-up (3.0 Phase 1, part 2), then signed org **bundles** + RBAC (Phase 2).
