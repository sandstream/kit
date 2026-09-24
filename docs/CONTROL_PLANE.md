# kit control plane (self-hostable, offline-verified)

kit's control plane (5.0 Pillar 2) is a **verifier and distributor of signed artifacts, not
a runtime-dependent service.** It has **no server logic**: the "plane" is a folder of signed files
that can be hosted in a file server, object store, or git remote. The current pull commands read
only a local directory or `file://` directory; mount or sync remote artifacts locally before
pulling. Every machine verifies those files **offline** against a committed trust anchor. There
is no telemetry or built-in network fetch; if the source disappears, kit falls back to the local
floor.

## What it distributes

| Artifact                               | Verb (produce)            | Verb (consume)                      | Effect                                                                    |
| -------------------------------------- | ------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `.kit-policy.toml` + `.kit-policy.sig` | `kit policy sign`         | `kit policy pull <src>`             | org policy-as-code, incl. the `[rbac]` role→permission table (fleet-RBAC) |
| `revocations.jsonl`                    | `kit panic` / rotate      | `kit policy pull-revocations <src>` | identity-key revocations (monotone, add-only)                             |
| `.kit-approvals.jsonl`                 | `kit policy approve <op>` | (honored by `requestApproval`)      | time-boxed, operation-scoped approvals                                    |

## The trust anchor (`.kit-policy.signers`) — bootstrapped out of band

The anchor lists the org's public keys and is the root of all verification. It is **never fetched
over the network** — commit it to the repo (or provision it by hand) so a pull can only ever deliver
artifacts your _existing_ trusted keys signed. Add a key with
`kit policy trust <pubkey.pem> [--label <name>]`.

> Root trust from the network would make the whole chain only as strong as the fetch. A pulled
> `.kit-policy.signers` is ignored; the local anchor is never overwritten by a pull.

## Self-hosting the source

1. On an authorized machine, produce the artifacts: `kit policy sign`, `kit policy approve …`,
   emit revocations via `kit panic`/rotate.
2. Place the files in a shared folder, or publish them to a git remote, S3/GCS bucket, or nginx
   directory and mount or sync them into a local directory. No server code is needed.
3. On each machine, commit the `.kit-policy.signers` anchor, then pull from that local directory:
   ```
   kit policy pull            <source>   # fetch + verify the org policy (and its RBAC) offline
   kit policy pull-revocations <source>   # merge authoritative revocations (add-only)
   ```
   A `source` is a local path or `file://` directory holding the artifacts above. An `https://`,
   S3, GCS, or git URL is not accepted directly by either pull command.

## Safety invariants (all enforced, fail-closed)

- **Verify before apply.** A pulled policy is staged and run through `verifyPolicy` against the local
  anchor; only a `valid` signature is written. Anything else keeps the existing policy.
- **No root-trust-from-the-network.** The anchor is local-only; no anchor ⇒ pulls fail closed.
- **Monotone revocations.** A pulled feed can only _add_ revocations (dedup by kid+ts+sig); it can
  never un-revoke a key. Only records signed by an org authority are honored.
- **Approvals are org-signed + time-boxed.** `requestApproval` honors a signed token only if it is
  from an org authority, unexpired, matches the exact operation+environment, and the signer isn't
  revoked — otherwise it falls back to interactive approval. Never auto-approves.
- **Air-gap stays green.** Pull/approve are manual and offline; `kit airgap verify` never triggers a
  fetch. `kit doctor` surfaces the control-plane posture (org policy present / verified / RBAC).

## Posture

`kit doctor` reports a **control plane (org policy)** row: `skip` (nothing distributed), `pass`
(present + verified, with any RBAC counts), `warn` (present but unsigned/unverifiable), or `fail`
(invalid/revoked/unparseable — not trusted).
