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

> **`[policy.agent_writes]` is declarative only as of 6.3.0.** The list is parsed and
> folded into the exported `KIT_POLICY_HASH`, so an upstream classifier reading that hash
> can honor it — but no kit code path consults the list. `checkPolicy()` has no caller
> outside its own module, so declaring a vendor op neither allows nor denies anything in
> kit, and no `policy-check` audit event is written. `.kit-policy.toml` and the
> elevation / read-only gates are the layers that actually enforce. Wiring the
> pre-approval is [on the ROADMAP](../ROADMAP.md) as its own arc.

## Enforcement: `kit policy check`

```
kit policy check            # evaluate the signed policy against this machine's state
kit policy check --strict   # a missing required scanner also fails
kit policy check --json     # machine-readable report + exit code (for CI)
```

`kit policy check` verifies the signature first (the trust anchor), then evaluates
the machine-checkable requirements and prints a per-requirement verdict:

| Requirement                 | How it's checked                                                              |
| --------------------------- | ----------------------------------------------------------------------------- |
| signature                   | authentic? (warn if unsigned/unknown signer; **fail** if tampered or revoked) |
| `min_kit_version`           | current kit version ≥ required (deterministic)                                |
| `required_scanners`         | each resolvable mise-first (warn if missing; **fail** under `--strict`)       |
| `prod_writes_need_approval` | `.kit.toml [governance.approval].production_writes` is set                    |
| `require_triage`            | reported — enforced at runtime by the install-gate (not duplicated)           |
| `thresholds`                | reported — enforced by the relevant data-source plugin (e.g. CodeScene)       |

It is **opt-in**: with no `.kit-policy.toml` it is a no-op (exit 0). A hard failure
(non-zero exit) is a tampered/revoked signature, an invalid schema, an unmet
`min_kit_version`, or — under `--strict` — a missing required scanner. Run it as a
CI step (`kit policy check --strict`) to gate on the signed org standard.

## Org distribution: `.kit-policy.signers` (the trust anchor)

A locally-signed policy only verifies on the machine that signed it. To distribute
ONE org standard across MANY repos, commit a **trust anchor** — `.kit-policy.signers`
— listing the org public key(s) allowed to sign the policy:

```
kit identity show --public > org.pub          # on the org's signing machine
kit policy trust org.pub --label acme-security # in each repo (commit the result)
kit policy trust --list                        # show trusted signers
kit policy trust --remove <kid>                # revoke trust in a signer
```

`verifyPolicy` resolves the signer key in trust order: a pinned `--key` → this
machine's own identity → the committed org anchor. So a policy signed by the org
key verifies as `valid (org trust anchor)` on any clone — asymmetric, no shared
secret, only public keys distributed.

**Fail-closed once anchored.** With a `.kit-policy.signers` present, a policy whose
signer is NOT in it is a hard **fail** in `kit policy check` / `kit ci` (not a
warn) — distribution must mean enforcement, the same discipline as the HMAC audit
anchor. Without an anchor, an unknown signer stays a warn (trust-absence ≠ forgery).

## What's next

Signed org **bundles** (packaging the policy + signer manifest for drop-in) and
RBAC keyed to identity (which role may read/write/elevate/install/deploy) —
Phase 2 depth.
