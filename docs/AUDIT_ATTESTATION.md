# Attested audit trail

kit 1.39.0 adds two layers on top of the `.kit-audit.jsonl` hash chain: an
external HMAC anchor for the audit log, and a signed check-attestation receipt.
This document states precisely what each layer does and, just as important, what
it does NOT guarantee.

## 1. The starting point: a tamper-evident, not tamper-proof, chain

Each line in `.kit-audit.jsonl` carries `prev` (the previous line's hash) and
`hash` (sha256 over the line's pre-hash JSON). `kit audit verify` re-walks the
chain and catches any edit, insertion, deletion, or reorder.

The chain is **keyless**: the hashes seed from a public genesis constant
(`"0".repeat(64)`) and use plain sha256. So a writer who can rewrite the log can
also recompute `prev` + `hash` for every line and produce a chain that
`verifyAuditChain` accepts. There is no key, no stored tip, and no stored entry
count, so a full rewrite (or a truncation/rollback) is invisible to the keyless
check. The chain is tamper-EVIDENT against accidental or naive edits; it is not
tamper-PROOF against a writer who recomputes it.

## 2. External HMAC anchor (`kit audit anchor` / `kit audit verify`)

A machine-local key lives at `~/.kit/audit-anchor.key` (0600, created on first
use, `icacls` owner-only on Windows). An anchor record at
`~/.kit/audit-anchor.json` (0600) stores, per log path, an HMAC `tip` over the
sealed prefix and the `count` of entries it covers.

- `kit audit anchor` seals the current log: it verifies the keyless chain, then
  folds an HMAC chain over every line hash with the anchor key and records the
  resulting tip + count.
- `kit audit verify` re-checks the keyless chain, then (when an anchor exists and
  the key is readable) recomputes the tip over the first `count` line hashes and
  compares it to the stored tip, and checks that at least `count` entries remain.
- The append path stays KEYLESS. A project-sandboxed agent that cannot read
  `~/.kit` still appends audit entries; anchoring is best-effort and fail-soft on
  the write path and never blocks an append. Set `KIT_AUDIT_ANCHOR=0` to disable
  append-time anchoring; set `KIT_AUDIT_ANCHOR_DIR` to relocate the key + record
  (used by the test suite for isolation).

Detection properties:

| Attack                                                       | Keyless chain | HMAC anchor (default)                                             | HMAC anchor (`--strict` / `require_anchor`) |
| ------------------------------------------------------------ | ------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| Edit one line, leave the rest                                | detected      | detected                                                          | detected                                    |
| Rewrite + re-chain the whole log without the key             | NOT detected  | detected (tip-mismatch)                                           | detected                                    |
| Truncate / roll back to fewer entries                        | NOT detected  | detected (count)                                                  | detected                                    |
| Append forged NEW entries beyond the seal (keyless re-chain) | NOT detected  | surfaced LOUDLY as unsealed tail                                  | FAIL (unsealed entries are unauthenticated) |
| Repoint `log_file` at a forged, never-anchored log           | n/a           | warn (no-anchor)                                                  | FAIL once any log is anchored / required    |
| Rotate / replace the anchor key                              | n/a           | reported as `anchor-key-changed` (distinct from a content tamper) | FAIL                                        |

### Fail-closed mode (`--strict` / `require_anchor`)

By default an unanchored log, an unreadable key, an unsealed tail, and a rotated
key are warnings, so existing logs stay compatible. Turn them into hard failures
(non-zero exit) with `kit audit verify --strict` or `[governance.audit]
require_anchor = true`. Fail-closed is ALSO implicitly active once this machine
has anchored ANY log: a no-key writer must not be able to repoint the
project-writable `log_file` at a forged, never-anchored file and have verify pass
green.

An unsealed tail (entries appended after the last `kit audit anchor`) is
unauthenticated: a writer without the key can append keyless-rechained entries.
The keyless chain accepts them; the anchor surfaces them loudly and, under
strict mode, fails. Re-run `kit audit anchor` to seal them.

A key rotation (the current key no longer matches the one that sealed the
record) is reported as `anchor-key-changed`, NOT a content tamper. Old anchors
are invalid by design after a key change; re-anchor to re-establish the seal.
The append-time auto-advance will NOT silently re-seal a prefix that no longer
verifies under the current key, so a real tamper/rotation alarm cannot be erased
by the next audited write.

### Threat boundary (read before claiming anything)

The anchor raises the bar from "anyone who can WRITE the log can forge it" to
"only someone who can READ the 0600 anchor key can forge it". It is **NOT**
tamper-proof against a same-UID local principal: an attacker running as the same
user can read `~/.kit/audit-anchor.key` AND the anchor record, recompute the tip,
and re-seal a forged log. Do not describe this as tamper-proof.

## 3. Signed check-attestation receipt (`kit check --attest`)

With `--attest` (or `KIT_ATTEST=1`), `kit check` / `kit ci` writes
`.kit-check-attestation.json`: `{ schema, command, timestamp, kit_version,
overall_ok, results summary, scanners_ran[], signature }`. `scanners_ran`
records which security gates actually ran versus were skipped/errored, so the
receipt proves which gates ran and that none failed open.

Emission is **opt-in** because writing a new file into the repo on every run
would surprise scripted users. The sign step is fail-soft: a signing failure
never blocks the check from completing, and at worst the receipt is emitted
unsigned (`sig_alg: "none"`) with a reason.

Signing precedence:

1. **HMAC-SHA256** with the machine-local audit anchor key. DEFAULT and
   authoritative: the verifier needs the same machine-local key, so a valid MAC
   genuinely binds the receipt to a key-holder (real authenticity).
2. **Ed25519** keypair at `~/.kit/attestation-ed25519.key` (portable fallback,
   or when explicitly requested). The receipt embeds its SPKI public key, but
   that embedded key is **UNTRUSTED**: anyone can mint a keypair, sign
   `overall_ok: true`, and embed their own public key. Authenticity therefore
   requires the verifier to authenticate the key.

Verify with `kit check verify-attestation [file] [--key <spki|fingerprint>]
[--pin]`.

### Ed25519 authenticity (do NOT trust the embedded key)

A self-signed Ed25519 receipt proves **integrity of its own claims only** - that
the payload was not altered after signing. It does NOT prove WHO produced it: the
public key travels inside the receipt, so a forger simply embeds their own. The
old framing that "forgery requires reading the key" is FALSE for the Ed25519
path and has been removed.

To authenticate an Ed25519 receipt the verifier must compare the embedded key
against an expected one:

- `--key <spki-pem | fingerprint>` - the operator pins the expected key inline.
- a **TOFU pin** in `~/.kit/attestation-ed25519.pin` (0600) - `verify --pin`
  records the current key as trusted-on-first-use; later receipts must match.
  Pinning a key you have not independently verified trusts whoever produced that
  first receipt.

With no `--key` and no pin, an Ed25519 receipt verifies as
`unverified-authenticity`: the signature is mathematically valid but the signer
is unauthenticated. This is **NOT** a green pass. A receipt whose key does not
match the pin/expected key FAILS (possible forgery). Verify output surfaces the
key fingerprint (`sha256:…`) so it can be pinned.

### Threat boundary

A same-UID attacker who can read the signing key (the HMAC anchor key or an
Ed25519 private key) can forge a receipt. An HMAC receipt (or an Ed25519 receipt
matching a pinned key) proves "the gates ran and passed on a host holding this
key", not "the gates ran on an untampered host". An unpinned self-signed Ed25519
receipt proves only the integrity of its own claims, nothing about authenticity.
Same same-UID boundary as the audit anchor.

## 4. Closing the same-UID gap (external anchor, not shipped)

Both layers above fall to a same-UID attacker who can read the local key. The
only way to close that is an anchor the local principal cannot rewrite: an
RFC3161 Time-Stamping Authority over the tip, or a remote append-only log.

kit ships a documented extension point (`ExternalTimestampAnchor` /
`resolveExternalAnchor` in `src/audit-anchor.ts`) but no network TSA client,
because a default network call would break the local-first / no-egress posture.
An enclave wires its own implementation and treats a missing or failed external
anchor as a verification failure, the same fail-closed contract as the air-gap
provenance path (`docs/AIR_GAP.md`).
