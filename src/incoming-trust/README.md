# Incoming trust internals

These modules prepare an incoming execution gate. No CLI command or execution path uses this gate yet.
A successful decision does not authorize a running process or prove that its files match the supplied digest.

## Components

- `npm-lock.ts` inventories supplied npm lockfile inputs. It does not fetch or verify package artifacts.
- `decision.ts` validates candidate-bound Ed25519 approval against an externally supplied authority.
- `authority-store.ts` stores authority and candidate state outside the repository through `IncomingTrustStore`.
- `snapshot.ts` captures a complete local tree and verifies its versioned content digest.
- `npm-artifact-integrity.ts` compares an owned byte copy against supplied SRI metadata.
- `npm-artifact-manifest.ts` checks manifest identity and script fields without execution.

The store exposes `read`, `update`, and `decide`. Callers must supply an absolute repository path.
The default directory uses the operating-system account home. It does not use `HOME` or repository configuration.
The optional directory argument belongs to trusted host code and isolated tests. Do not expose it as a repository-controlled setting.

## State transitions

Every mutation after enrollment supplies the observed generation and phase. Both must match the stored state inside the transaction.

| Action   | Required state                                                   | Result                                                                                             |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `enroll` | No prior enrollment; valid external authority at generation one. | Pending, without a candidate or approval.                                                          |
| `stage`  | Current generation and a candidate digest.                       | A changed digest advances the generation and clears approval. An unchanged digest preserves state. |
| `accept` | Pending candidate and current generation.                        | Complete, valid, signed evidence establishes accepted state.                                       |
| `reject` | Current generation.                                              | Advances the generation and removes approval. An existing rejection remains unchanged.             |
| `retry`  | Rejected state and current generation.                           | Advances the generation and returns to pending. Fresh evidence is required.                        |

When a new candidate replaces an accepted one, the accepted candidate becomes the next baseline.
A `reject` or `rotate` voids the approval and leaves the baseline where it was.
A repeated `stage` never clears a rejection. Enrollment never replaces existing authority.
SQLite transactions serialize state changes. Acceptance changes phase without changing the signed candidate generation.
The phase check prevents an earlier pending writer from replacing that acceptance.

## Storage and decision boundaries

The store binds enrollment to the canonical repository path and its filesystem identity.
Repository aliases share the binding. A replacement directory cannot reuse it.
State reads validate the schema and stored approval. Decisions recheck the candidate digest and evidence expiry.
Missing, pending, rejected, malformed, expired, or mismatched state cannot return an allowed decision.
Reads create no authority files. Read-only mode refuses mutations. Corrupt state is not repaired or reset implicitly.

### Recovery of a damaged store

`quarantineDamaged(repository, QUARANTINE_ACKNOWLEDGEMENT)` is the only recovery path. It moves `authority.sqlite` and any `-wal` and `-shm` files to `authority.sqlite.damaged-<time>-<random>` in the same private directory. Nothing is deleted, rewritten or overwritten.
It refuses a store that still reads correctly, a missing store, read-only mode and a wrong acknowledgement. A healthy approval therefore cannot be discarded this way.
The database file holds every repository in that directory. After recovery each repository needs a new enrollment, and no earlier approval survives.
Only a newly created database can receive the initial schema. A pre-existing empty database is refused.
The store accepts SQLite rollback mode only. It checks the file header and refuses WAL or SHM sidecars before opening SQLite.
The store keeps public signer keys and approval evidence. It does not keep private signing keys.
Public key input must contain only the public PEM representation. Additional PEM blocks or text are refused before storage.

The store requires trusted host code and trusted parent directories.
Private file permissions are not isolation from another process with the same operating-system account.
Windows paths require the strict ACL helper. Native Windows verification remains outstanding.

## Captured inputs

`captureIncomingSnapshot(source, destination, limits)` copies the source into a new private destination.
Both paths must be absolute. Trusted host code chooses the destination and optional limits.
The destination parent must be private. Existing destinations, overlapping trees, and linked destination parents are refused.
No ignore rule applies. Hidden files, untracked files, dependency directories, and Git metadata beneath the source are included.
A Git pointer file remains a file. It does not import an external Git directory.

The manifest binds regular file bytes, executable intent, empty directories, and relative link targets.
It excludes host paths and timestamps. Internal relative links remain links; native path resolution checks their targets.
Absolute links, escaping links, special files, and unsupported path encodings are refused.
Windows symbolic links are currently unsupported. Native Windows verification remains outstanding.

Default limits are 100,000 entries, 1 GiB total payload, and 128 MiB per file.
The maximum depth is 64 path components, including the leaf file, directory, or link.
Paths and link targets have a 4,096-byte limit. The manifest has a 16 MiB limit.
The root directory counts as an entry. A failure removes only the new destination that the operation still owns.

Capture checks source identity and metadata during reads and after traversal. Observed source changes cause refusal.
These checks do not create an atomic filesystem snapshot. Approval must apply to the captured tree, never the changing source.
Capture verifies the copied tree before returning. `verifyIncomingSnapshot(destination, expectedDigest, limits)` checks the manifest and actual captured files again.
Verification creates no files. It refuses missing, added, changed, or uncontrolled copied inputs.

Capture does not execute project scripts or Git hooks. Windows permission helpers can invoke trusted system tools.
Files remain writable by their owner. This module supplies neither immutable storage nor isolation from the same operating-system account.
Inputs outside the source are not captured. A future isolated launcher must control those inputs separately.

## Remaining integration

Snapshot lifecycle, exact artifact verification, approval UI remain separate work.
Execution needs a lock over the approved inputs and independent workload isolation.
Do not use `decide` followed by an unlocked process launch as an execution gate.

Tests use the public store interface, temporary directories, real SQLite, and independently encoded Ed25519 signatures.
The concurrent-write test uses two separate Node processes. No test uses the operator's authority store.

## Artifact checks in development

The byte-inspection interface passes initial artifact tests. Archive and transport implementations remain under development and review.
The network-to-inspection flow and complete verification remain unfinished.
The checks below do not authorize installation or execution.

Integrity comparison requires canonical Base64 and validates every supplied token.
SHA-512 takes precedence over SHA-384, which takes precedence over SHA-256.
Any matching token at the strongest supplied algorithm succeeds. A weaker match cannot rescue a stronger mismatch.
SHA-1 tokens are validated but never selected. SHA-1-only metadata is refused.
Unknown algorithms, malformed tokens, and unavailable native algorithms cannot cause fallback.
Valid SRI option suffixes remain in the matched-token evidence. They do not change the digest comparison.
Metadata is limited to 16,384 UTF-8 bytes and 64 tokens, including duplicates.
These are explicit Kit compatibility limits. They do not describe all input forms npm accepts.

The integrity result records the algorithm, matched token, actual digest, and copied byte count.
It does not retain the caller's Buffer. The complete artifact interface must hash and inspect the same owned compressed bytes.
Neither a mutable file path nor the caller's original Buffer can establish that relationship.

Manifest inspection requires exact name and version equality with the selected package identity.
The installation name of an npm alias is separate from the real package name.
The root manifest must contain a script object with string values, or omit the script field.
The parser rejects duplicate object keys, invalid UTF-8, invalid JSON, and nonobject roots.
It accepts one leading UTF-8 BOM. Limits are 1 MiB and 128 nested JSON containers, including the root.
The lock inventory and manifest inspection share JSON syntax, duplicate-key, and depth checks.
The manifest result contains script text as data. No package script, module, or project configuration is executed.

## Candidate identity

`bindIncomingCandidate` in `candidate.ts` joins three verified parts into one `candidateDigest`: the digest of a captured snapshot, the lock inventory, and one verified artifact result for each inventory artifact.
The caller must have verified the snapshot with `verifyIncomingSnapshot` and each artifact with `inspectNpmArtifact`. The function does not read files and does not fetch.
It refuses instead of producing a partial candidate. The refusal reasons are `invalid-snapshot-digest`, `inventory-incomplete`, `artifact-source-unsupported`, `artifact-not-verified`, `artifact-duplicate`, `artifact-unexpected`, `artifact-missing` and `artifact-selection-mismatch`.
Git, local and bundled sources have no byte verification yet. They refuse the whole candidate.
The digest does not depend on the order of artifact results. It changes when the snapshot, an inventory field, the fetched bytes, the manifest scripts or the archive shape change.
The returned checks (`snapshot`, `npm-artifacts`) match the `IncomingCheck` shape that `decide` expects. The digest does not authorize execution and does not isolate it.

`captureIncomingCandidate` in `candidate-flow.ts` captures the source once. It reads `package.json`
and the lockfile from the protected copy. It fetches and inspects the locked artifacts under the
caller's host policy. It retains their exact compressed bytes in `artifacts/` in inventory order.
Kit limits each archive to 16 MiB and the combined compressed archives to 256 MiB.

`verifyRetainedIncomingCandidate` verifies the captured tree and binds a fresh candidate from
the retained artifacts without reading the source, a package cache or the network. It compares
the result to the expected snapshot and candidate digests. Capture calls this check before it
returns a bound candidate. Archive storage must contain exactly one regular private file for
each artifact. A candidate staged before archive retention needs to be staged again to get
the retained files.

Capture refuses unreadable inputs, a missing lockfile, both lockfiles at once and incomplete
or unsupported inventories. It caps inventories at 1,000 artifacts by default.
`artifact-refused` includes the inspection or download cause. `artifact-storage` indicates
missing, invalid or unwritable retained files. `snapshot-changed` and `candidate-changed`
indicate a mismatch on verification. A refusal after capture returns the snapshot, and the
caller owns that directory. The offline check produces candidate evidence. The separate
run operation checks that evidence against the signed approval inside the generation lock.

## Approval lifecycle

`lifecycle.ts` wraps `IncomingTrustStore` for the operator flow. Each call reads the state once and passes the observed generation and phase back. The store refuses the change if another writer moved first.

- `stageCandidate` records a candidate digest. The same digest changes nothing. A different digest advances the generation and clears approval. A rejection stays in place.
- `requestApproval` builds the verification report that the external authority signs, and returns its digest. It refuses outside the pending phase and refuses checks that cannot satisfy the enrolled authority (`checks-incomplete`), because such a report can never be accepted.
- `acceptCandidate` hands a signed approval to the store. The store checks the signature, context, checks and expiry inside its transaction.
- `rejectCandidate` and `retryCandidate` move the state. A retry needs fresh evidence and a fresh approval.

The lifecycle functions record decisions. The run operation holds the lock and manages the
external delegate.

## Operator commands

`kit security incoming <sub>` drives the store. Every subcommand accepts `--repo <dir>` (default: the current directory), `--store <dir>` and `--json`.

| Subcommand                                                           | What it does                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `enroll --authority <file>`                                          | Enrolls the repository with an authority file from the external signer.                                                              |
| `status`                                                             | Prints phase, generation, candidate digest, signer ids and approval expiry. Reads only.                                              |
| `stage --source <dir> --snapshot-dir <new dir> --origin <https url>` | Captures the source once, fetches and checks every locked artifact against the given origins, and stages the bound candidate digest. |
| `preflight --snapshot-dir <dir> --verification <file> [--sealed]` | Checks the retained files against the precise signed report under the generation lock. The sealed option also checks a temporary read-only APFS image of those files. |
| `run-policy --policy <file>` | Computes the launch policy digest for independent enrollment. |
| `run --snapshot-dir <dir> --verification <file> --policy <file>` | Runs the approved Node entry from the sealed image through the supported external macOS delegate. |
| `request --checks <file> [--out <file>]`                             | Builds the verification report and prints the digest that the external signer signs.                                                 |
| `approve --verification <file> --approval <file>`                    | Records an approval. The store verifies the signature, context, checks and expiry.                                                   |
| `reject`, `retry`                                                    | Move the state. A retry needs fresh evidence and a fresh approval.                                                                   |
| `rotate --signers <file>`                                            | Replaces the signers and returns the state to pending.                                                                               |
| `recover --acknowledge <text>`                                       | Moves a damaged store aside. See "Recovery of a damaged store".                                                                      |

kit never signs. The mutating subcommands are refused in read-only mode, and `request` is refused with `--out`. Input files must be regular files under 1 MiB. `--out` refuses to overwrite a file.
`approve` does not start the candidate and does not hold a launch lock.

The macOS arm64 Node delegate uses an external sandbox and a read-only APFS input image.
The policy digest binds its runtime, system profile, host build, entry, private output
directory, time limit and restriction rules. Kit holds the volume and the generation
lock through startup and process completion. The executable comes from a separate read-only
image verified against the policy digest. This delegate requires zero network destinations,
zero host credentials and zero child processes. The runtime builds each supported locked npm
package from the retained tarball. The verifier checks a read-only derived tree against the
approved file manifest and the file digests produced by the archive parser. Kit binds its
derivation recipe and independently provided SHA-256 expectations for every compressed
npm archive to the launch policy digest. Captured package directories, native addons and
workspace links are refused. The TypeScript supervisor runs outside the sandbox. It owns the workload deadline
and stops the process if Kit exits. See the operator guide for the policy and output format.
