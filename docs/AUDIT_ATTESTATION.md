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
  `~/.kit` still appends audit entries. An unavailable anchor does not make a successful local append fail.
  Set `KIT_AUDIT_ANCHOR=0` to disable
  append-time anchoring; set `KIT_AUDIT_ANCHOR_DIR` to relocate the key + record
  (used by the test suite for isolation).
- A writer waits up to 5 seconds for the audit lock, then the append fails and says so. Several
  writers queue behind one lock, so on a slow disk the last one can need longer.
  `KIT_AUDIT_LOCK_WAIT_MS` raises the wait (at most 120000). A value under 5000 is ignored, so the
  variable cannot make appends fail sooner.

Detection properties:

| Attack                                                       | Keyless chain | HMAC anchor (default)                                             | HMAC anchor (`--strict` / `require_anchor`) |
| ------------------------------------------------------------ | ------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| Edit one line, leave the rest                                | detected      | detected                                                          | detected                                    |
| Rewrite + re-chain the whole log without the key             | NOT detected  | detected (tip-mismatch)                                           | detected                                    |
| Truncate / roll back to fewer entries                        | NOT detected  | detected (count)                                                  | detected                                    |
| Append forged NEW entries beyond the seal (keyless re-chain) | NOT detected  | surfaced LOUDLY as unsealed tail                                  | FAIL (unsealed entries are unauthenticated) |
| Repoint `log_file` at a forged, never-anchored log           | n/a           | warn (no-anchor)                                                  | FAIL once any log is anchored / required    |
| Rotate / replace the anchor key                              | n/a           | reported as `anchor-key-changed` (distinct from a content tamper) | FAIL                                        |

### Concurrent writes and recovery

Kit uses one SQLite coordination file beside each audit log, named `<log path>.lock.sqlite`.
The lock covers the previous hash read, the append, and the optional anchor update.
Directory and file aliases use the same canonical log path. Logs with multiple hard links are refused.
Separate logs use separate locks. The shared anchor index has its own lock for record updates.
The lock order is the log first, then the anchor index.
Each lock acquisition has a five-second limit. The protected operation can take longer.

These locks require a local filesystem with working SQLite locks and trusted parent directories.
Do not remove or replace coordination files during use. Kit retains them after each operation.
Process exit releases the operating system lock. File writes are not a SQLite transaction.
A process or machine failure can leave an incomplete log entry or an unsealed tail.
Kit refuses further appends to an invalid chain and preserves the existing bytes.
An automatic anchor update does not absorb an earlier unsealed tail.

Kit publishes the anchor index as a complete file and preserves records for other logs.
An invalid or unreadable index produces an error. It does not represent an empty machine.
An explicit seal refuses a snapshot when the current log differs.
Existing records under directory aliases remain readable. Conflicting alias records require inspection.

Preserve damaged logs and anchor files before recovery. Restore only from a trusted backup.
Run `kit audit verify` after recovery. Inspect any unsealed tail before an explicit `kit audit anchor`.
Run `kit audit verify --strict` to confirm that the complete current log has a valid seal.
Include the default `.kit-audit.jsonl.lock.sqlite*` files in `.gitignore`.
For a custom log path, also ignore its corresponding coordination files.

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

## 2.5. Identity signatures on audit entries (`kit identity` + `kit audit verify`)

The HMAC anchor is the INTEGRITY layer (was anything edited / rolled back). It is
symmetric, so it answers "was this tampered" but not "who wrote it" — a verifier
holding the anchor key could itself have produced any entry. The identity layer
is the orthogonal ATTRIBUTION layer.

When a local `kit identity` exists (an Ed25519 keypair under `~/.kit`, see
`kit identity`), each appended audit line is additionally signed: kit signs the
line's `hash` and attaches two fields the chain does NOT cover, `kid` (the
signer's identity id) and `sig` (base64 Ed25519 signature over `hash`).

- **Signing is best-effort and append-safe.** No identity → entries are written
  exactly as before (no `kid`/`sig`). A signing failure never blocks the append.
- **`kid`/`sig` sit OUTSIDE the hashed remainder.** `verifyAuditChain` strips
  them before recomputing the hash, so a log mixes signed and unsigned lines and
  the chain still verifies end to end. Existing/legacy logs are unaffected.
- **`kit audit verify` reports the signature tally** after the chain + anchor
  checks: `verified / signed` against the locally-known keys (the current
  identity plus archived rotated keys), how many were signed by an unknown key
  (`unverifiable`), and how many were keyless (`unsigned`).

Verdict rules (`verifyAuditSignatures`):

| Condition                                  | Effect on verify                                        |
| ------------------------------------------ | ------------------------------------------------------- |
| Signature valid for a known `kid`          | counted `verified`                                      |
| Signature INVALID (forged / hash tampered) | hard FAIL (`invalid > 0`)                               |
| `kid` not resolvable to a public key       | `unverifiable` — fail-OPEN (absence of trust ≠ forgery) |
| No `kid`/`sig` (legacy/keyless)            | `unsigned` — fail-OPEN                                  |

**Attribution of a SEALED entry is tamper-evident (anchor v3).** The fail-OPEN
rows above mean a fresh log's _missing_ attribution is treated as benign. On its
own that left a gap: a writer-only attacker could **strip or rewrite `kid`/`sig`
on an entry that was already signed AND anchored** — the keyless chain re-hashes
without those fields, the signature tally just re-counts it as `unsigned`, and
the old hash-only anchor tip was byte-identical. The HMAC anchor now folds
attribution into the seal (record `version: 3`, `computeAnchorTipV3` over
`hash | kid | sig` per line), so stripping or altering the signer of any
**anchored** entry changes the tip and is caught as a hard `tip-mismatch`. A
keyless entry seals with empty attribution, so forging a `kid`/`sig` ONTO a
sealed keyless entry is caught the same way. Legacy `version ≤ 2` records keep
verifying hash-only until the next `kit audit anchor` re-seals them as v3.

Asymmetric payoff: a remote / CI / teammate verifies WHO produced an entry with
only the PUBLIC key — never a forge-capable secret, unlike the HMAC anchor. Same
same-UID boundary applies for _production_: a same-UID principal can read the
0600 private key and sign as this identity. Non-exportable key storage closes
that gap: configure an external signer (`KIT_KEYSTORE=command` plus a sign
command and its public key, see `src/keystore/command-store.ts`) and check it with
`kit identity keystore`. The native TPM and Secure Enclave stores are stubs that
report unavailable. What it buys today is
offline, third-party-verifiable attribution that the symmetric anchor cannot
express.

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

## 4. External receipt verification

Kit delegates authority-specific cryptography to an operator-configured verifier. Kit does not include a network timestamp client.
Configure `KIT_EXTERNAL_ANCHOR_CMD` for issuance and `KIT_EXTERNAL_ANCHOR_VERIFY_CMD` for verification.
These are trusted operator commands. Receipt data and project configuration must never select the verifier or its trust roots.
The commands receive JSON on stdin. Do not construct shell commands from receipt fields.
The legacy `KIT_ANCHOR_TIP`, `KIT_ANCHOR_COUNT`, and `KIT_ANCHOR_LOGPATH` fields remain available to the issuer.

`kit audit anchor --external` verifies the returned receipt before it publishes the local anchor record.
A missing verifier, failed authority, invalid receipt, or unavailable checkpoint prevents publication.
`kit audit verify --require-external` requires authenticated evidence and an acceptable current external checkpoint.
The same requirement applies with `--all`, including an empty index or a missing log.
Required external verification also rejects missing keys, changed keys, unanchored logs, and unsealed tails.
Verification does not call the issuer, create a key, repair a record, or advance a checkpoint.

Without `--require-external`, the HMAC policy remains available independently.
An unchecked external receipt is identified as unverified. A verifier's invalid verdict is a failure even without the flag.
Legacy receipts without the versioned statement remain unverified. Inspect the log before an explicit external reseal.

### Statement and verifier protocol

Requests use `version: 1`, `operation: "anchor" | "verify"`, a fresh `requestId`, and a `statement`.
The statement uses these fields in this order:

| Field            | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| `version`        | `1`                                                     |
| `domain`         | `kit.audit.external/v1`                                 |
| `logPath`        | The canonical log path bound at issuance.               |
| `count`          | The number of sealed entries.                           |
| `tip`            | The HMAC tip of those entries.                          |
| `anchorVersion`  | The anchor algorithm version.                           |
| `algorithm`      | `hmac-sha256`                                           |
| `keyFingerprint` | The anchor key fingerprint, or `null` for a legacy key. |

`statementDigest` is SHA-256 of the UTF-8 JSON statement, with this field order and no extra whitespace.
The verifier receives `receipt` and `receiptDigest` too. The latter hashes the transmitted receipt JSON by the same rule.
The transmitted receipt contains `token`, `authority`, `timestamp`, and `statement`, in that order.
Directory and case aliases may retain the bound path only when both paths identify the same existing file.
A different log, tip, count, algorithm, version, or key cannot reuse the statement.

The issuer returns `{ "token": "...", "authority": "...", "timestamp": "..." }`.
Kit stores the statement with that receipt. This metadata alone provides no authentication.
The verifier must authenticate every statement field, the authority, and the attested timestamp against independent trusted material.
Its response must contain:

```json
{
  "version": 1,
  "requestId": "the request identifier",
  "statementDigest": "the authenticated statement digest",
  "receiptDigest": "the examined receipt digest",
  "authenticity": "valid",
  "rollback": "acceptable",
  "authority": "the authenticated authority",
  "attestedAt": "the authenticated receipt timestamp"
}
```

Other authenticity results are `invalid` and `unknown`. Other rollback results are `stale` and `unknown`.
Kit checks response binding and requires both `valid` and `acceptable` for required external verification.
Missing fields, mismatched responses, process errors, timeouts, and excessive output cannot satisfy the requirement.
Exit zero alone is insufficient. A verifier that always echoes success does not implement this contract.

### Command execution limits

The adapter sends request data through stdin. The trusted command string selects the program.
It starts the command in the home directory with a limited inherited environment.
The inherited names are PATH, HOME, USERPROFILE, SystemRoot, TMP and TEMP when present.
The adapter derives KIT_ANCHOR_TIP, KIT_ANCHOR_COUNT and KIT_ANCHOR_LOGPATH from the request statement.
Provider credentials must come from the command's protected credential source.
Kit does not forward other environment variables, including NODE_OPTIONS and arbitrary KIT variables.

Requests and combined stdout/stderr each have a one-megabyte limit.
A command has a thirty-second deadline, followed by a bounded cleanup interval.
Nonzero exit, a signal, invalid UTF-8, excessive output or an incomplete process shutdown fails verification.
Kit suppresses provider diagnostics because they can contain credentials.

On POSIX, Kit owns a process group and stops that group on timeout or normal host SIGINT/SIGTERM.
Existing host signal listeners remain registered. Explicit termination from another listener can prevent cleanup completion.
SIGKILL cannot invoke cleanup. A descendant that creates another process group can escape this boundary.
Windows uses taskkill for an identifiable live process tree.
Descendants that close inherited pipes can escape detection after their Windows parent exits.
Native Windows console interruption and Linux execution require their own platform verification.
These controls bound normal command execution. They do not provide a sandbox for a malicious verifier.

### Trust and rollback limits

The verifier must use independently pinned authority keys or certificate policy.
It must compare the receipt with an independently protected checkpoint under an explicit freshness policy.
A timestamp proves existence at a time. It does not prove that a log is the latest available history.
An authentic old log, local anchor, and receipt can be restored together without breaking their signatures.
A writable local replay cache cannot prevent that complete rollback.
If the verifier cannot establish freshness, it must return rollback `unknown`, which fails required verification.

Protect the verifier executable, configuration, environment, trust roots, and checkpoint from the audited principal.
An attacker who controls the verifier or its launcher can replace the answer. Kit cannot establish those external protections itself.
Authority issuance policy must also reject unauthorized replacement history. A new timestamp over attacker-selected data does not establish legitimate history.

Read-only mode activation has its own audit event and can advance the local HMAC seal.
For inspection without a new activation event, start the verifier with `KIT_READ_ONLY=1` already active.
This is distinct from the verification operation, which does not modify the inspected evidence.
