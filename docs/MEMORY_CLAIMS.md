# Session-owned claims

Use this guide when claiming or handing off pending actions, renewing ownership,
resolving competing histories, or deleting a task. For verifier approval, recall
scope and encrypted transport, see [kit memory](MEMORY.md).

## Identity and receipts

A claim records `claim_owner` with exactly three fields: `device`, `harness` and
`session`. The CLI supplies the local device ID; callers explicitly supply both
`--harness <name>` and `--session <id>`. Kit does not infer the current session from
the latest transcript. Use the caller's actual identity consistently; a different
session on the same device is a different owner.

Each identity component is nonempty, at most 256 characters, and has no leading or
trailing whitespace or control characters. An optional positional `[label]` on
`claim` and `takeover` populates `claimed_by`; its default is the harness name.
That label is display metadata, not ownership.

`pal show` returns a `frontier`: an opaque digest of the currently observed head
revision IDs. `--expect <frontier>` binds a mutation to that observation. Successful
claim, renewal and takeover return the updated view from the same transaction as
the write. In JSON, retain `view.frontier` and `view.heads[].state.claim_owner`;
human output prints the frontier and owner. Inspection JSON instead places
`frontier` and `heads` at the top level.

These are concurrency receipts, not authentication credentials, signed receipts or
a distributed mutex. They reject outdated writes in the observed store, but cannot
stop external work already running on an offline replica. An account able to alter
the database or impersonate a caller is outside this coordination boundary.

## Claim and finish work

1. Inspect the task and its alternatives before acting:

   ```bash
   kit memory pal show <id> --history --json
   ```

   Continue with `claim` only when the current state is open and uncontested.
   Retain the inspected `frontier`. `show` is read-only and neither creates nor
   migrates the database.

2. Claim using that observation and explicit session identity:

   ```bash
   kit memory pal claim <id> --harness <name> --session <id> --expect <observed-frontier> --json
   ```

   Begin work only after `status: "applied"`. Retain the returned owner and new
   `view.frontier`; the pre-claim frontier is now stale. Supplying only a label,
   omitting any required flag, or claiming non-open work does not acquire it.

3. Renew when recording continued ownership:

   ```bash
   kit memory pal renew <id> --harness <name> --session <id> --expect <claim-frontier> --json
   ```

   Use the same owner and replace the saved frontier with the returned one. Each
   successful renewal creates a new revision, even within the same clock second.
   Renewal records activity; it does not extend a timeout or transfer ownership.

4. Complete, release or postpone using the latest receipt. Choose one transition:

   ```bash
   kit memory pal done <id> --harness <name> --session <id> --expect <latest-frontier> --json
   kit memory pal release <id> --harness <name> --session <id> --expect <latest-frontier> --json
   kit memory pal snooze <id> 7 --harness <name> --session <id> --expect <latest-frontier> --json
   ```

   Success clears claim ownership. `done` closes the task; `release` returns it to
   open; `snooze` postpones it. These CLI transitions return status, not a new view;
   inspect again before further work. A closed task can be reopened explicitly
   with `pal reopen <id> [--expect <frontier>]`.

`--expect`, `--harness` and `--session` are mandatory for `claim`, `renew` and
`takeover`. Transitions on claimed work also require the matching owner and current
frontier. On unclaimed work, `done`, `snooze`, `release` and `reopen` accept an
optional frontier; supplying one rejects intervening changes. Owner flags must
always be supplied together. With `pal add` or `configure --verify-http`, `--expect`
still means an HTTP status code, not a frontier.

Mutation commands exit 0 only when applied. Missing items, unchanged transitions,
stale receipts and ownership/conflict refusals exit 1; invalid input exits 2.
Read-only mode refuses mutations. Treat `stale` as a reason to inspect and
reconsider, not to silently fetch a newer frontier and replay the old intent.
`not-owner` requires the owning session or explicit takeover; `owner-required`
requires explicit identity and observation; `legacy-owner` requires takeover.

## Handoff and takeover

Claims have **no automatic 24-hour expiry**. `claimed_at` is advisory: listing,
session recovery and suggestions do not release claims based on age. A new session
or device must inspect the task and explicitly take over, even when the previous
session has ended. Imported claims retain their owner; changing a recall path or
device assignment does not transfer the claim.

SessionStart includes existing claimed work alongside open/conflicted work, using
the same project and device scope. Its agent context shows a limited selection of
claimed tasks with their structured owner as stored data, not instructions. The
trusted claim notice reports the count and fixed inspection guidance; Claude's
user-visible `systemMessage` does not include task titles or owner identities.
Recovery never takes over automatically. The default `pal list` still selects
open work plus conflicts; use `pal list --status claimed` to inspect claimed work.

```bash
kit memory pal list --status=claimed --json
kit memory pal list --conflicts --json
kit memory pal show <id> --history --json
kit memory pal takeover <id> --harness <name> --session <new-session-id> --expect <observed-frontier> --json
```

The lists retain project/device filters: add `--global` for other projects and
`--all` for other devices. `show` addresses the local display ID directly. With
multiple heads, add `--take <head-revision>` chosen from the inspected `heads`.
At least one current head must be claimed; otherwise use ordinary resolution and
claim open work afterward.

Takeover preserves the chosen head's task content, sets its status to claimed,
assigns the caller's owner and label, and clears close, snooze and next-check times.
It always writes a new revision acknowledging every observed head. Retain its
returned receipt before doing more work. The former owner's receipt is stale;
even a fresh observation does not let that owner mutate the new session's claim.

Historical claims may have `claimed_by` but no `claim_owner`, or a null owner.
Their session ownership is unknown, not inferred from labels, origin or timestamps.
They remain claimed until explicit takeover establishes an owner. After takeover,
the new owner may complete, release, snooze or forget using the new receipt.

Offline concurrent claims remain a conflict even with identical owners, labels and
timestamps. Takeover acknowledges only branches already observed; importing an
unseen branch later can restore the conflict. Coordinate external work separately.

## Resolve state or erase a task

Use `resolve` for ordinary state reconciliation, not to acquire or transfer a claim:

```bash
kit memory pal resolve <id> --expect <frontier> --take <head-revision> --json
kit memory pal resolve <id> --expect <frontier> --state <file> --json
```

Choose exactly one current head or supply its complete portable state object as
JSON. Resolution acknowledges all observed heads. For an existing, uncontested
claim, also supply the matching `--harness` and `--session`; a state that remains
claimed must retain that owner. Resolution cannot create a claim from unclaimed
work or transfer it. A conflict involving any claimed head requires takeover first,
including when the desired final state is unclaimed. A legacy unknown owner also
requires takeover.

Portable state excludes verifier definitions, grants, passing streaks and local
recall aliases. When resolving to an unclaimed status, clear `claim_owner` as part
of that state; only claimed tasks may retain an owner.

Deletion is a separate explicit operation:

```bash
kit memory pal forget <id> --expect <frontier> --json
```

For claimed work, add the matching `--harness` and `--session`. Contested or legacy
claims require takeover first. Success deletes the current task and revision
history, returning a logical-store erasure receipt. A content-free deletion
identity travels with imports and prevents stale copies from recreating it. Raw
restore refuses to discard destination deletion records; use safe import instead.
This does not erase retained encrypted backups, remote Git history or storage
blocks. Imported deletion may leave an inert local verifier hash marker because
an enclosing caller can still roll back the database transaction.

## Automatic maintenance

Expired snoozes still reopen during ordinary writable open-item listing and session
recovery, within local project/device boundaries. This does not apply to claims.

Scanner reconciliation (`palSyncFindings`) defers claimed or conflicted findings:
it neither refreshes their content nor closes them when absent from the next scan.
Its optional `deferred` array contains their IDs. This is a reconciliation result,
not a promise that every scanner UI renders it. Resolve ownership and release or
finish the task deliberately before ordinary scanner reconciliation resumes.

## Schema compatibility

Schema 16 adds structured `claim_owner` storage and ownership-aware write guards
over task state, revisions and deletion records. Current writes record state and
history atomically. Persistent triggers use `kit_pal_write_v16`; older clients
registering only the previous writer function cannot mutate those guarded records
in a migrated store. Local verifier settings and recall aliases remain separate.

Historical ten-field revision bodies stay historical: migration preserves their
existing `state_json` bytes and does not append an invented owner. Forwarding
retains that ten-field format. Ownership-aware claim events include `claim_owner`
as the eleventh field; null means no known owner. Comparison normalizes absent and null
owners without rewriting immutable history.

A declared schema 16 store missing ownership storage is refused, as are missing
causal tables or per-task history in a declared causal store. Recovery does not
invent legacy observations to conceal missing history. Newer or invalid versions
are refused on startup, read-only inspection and import before target row writes,
including encrypted imports with injection scanning disabled. Backup and raw
restore can preserve unsupported bytes for a compatible Kit release; never lower
the stored version to force an older client to open them.

These guards coordinate cooperative clients, not database owners who can remove
them. They do not retrofit old binaries operating on original, unmigrated stores.
