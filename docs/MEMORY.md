# kit memory

Local-first, deterministic memory for AI agents. `kit memory` gives a (swappable)
model a **verifiable second brain**: it stores your raw conversation history and
lets the agent _search it before answering_ — so it pulls receipts instead of
guessing. No vector database, no embeddings, no model calls. Just SQLite + FTS5
and a few fail-open hooks.

> **Memory is not context.** Context is durable, curated rules (`.kit.toml`,
> policy, `CLAUDE.md`). Memory is the experiential log of what happened. The bridge
> is one-way: memory becomes context only when the agent _retrieves it at the time
> of work_. kit keeps the two as separate shapes with one retrieval pipeline.

## Two tiers, split on the sharing boundary

|               | **Personal memory**                                                           | **Shared project memory**                                        |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Content       | RAW transcripts, one row per message                                          | curated, **redacted** entries (decisions, conventions, receipts) |
| Scope         | one `~/.kit/memory.db` (all projects); search defaults to the current project | per-project, organized by responsibility-area                    |
| Shared?       | **never** — private, `0600`                                                   | **yes** — committed text, travels with the repo                  |
| Shape (above) | MEMORY (experiential)                                                         | CONTEXT (curated, durable)                                       |

The personal store is yours and never leaves your machine unencrypted. The shared
store is curated knowledge that is **treated like code** — committed, reviewed, and
secret-scanned (see [Shared memory](MEMORY_SHARED.md)).

## Quick start

```bash
npm i -g sandstream-kit
kit memory install          # wire Claude Code + Codex lifecycle hooks
kit memory index            # index every supported harness into ~/.kit/memory.db
kit memory search "october pricing decision"
```

`install` is idempotent and non-destructive. It merges into
`~/.claude/settings.json` and `~/.codex/hooks.json`, preserving other hooks.
Codex command hooks require explicit review/trust through `/hooks`; until trusted,
Codex skips them. After activation, `SessionEnd` indexes the just-ended harness
incrementally — you rarely need to `index` again.

## How it works — fail-open lifecycle hooks, nothing more

Claude Code uses three lifecycle events; Codex uses the two capture/recovery
events below (all **fail-open**: an error yields a no-op, so a hook can never
block a prompt or break a session):

- **`UserPromptSubmit`** runs before every message and injects a two-sentence
  reminder that searchable memory exists (plus any open action items). The agent
  decides when to search — memory is _pulled on demand_, never bulk-loaded into
  context every turn. This is installed for Claude Code only: Codex renders hook
  stdout in the conversation UI, so its durable `AGENTS.md` instruction carries
  the same reminder without per-message noise.
- **`SessionEnd`** indexes the just-ended session into the store.
- **`SessionStart`** (recovery) re-injects "where you left off" for the current
  project: recent messages, open/conflicted work and existing claimed work within
  the project/device scope. Recovery surfaces ownership without taking over;
  see [Session-owned claims](MEMORY_CLAIMS.md#handoff-and-takeover).

That's it. No reranker, no summarization pipeline, no chunking, no hosted sync
service, no thirty-knob config. Less code, less surface area to break. (Optional
cross-device sync is your own git remote or command — see below, still no service.)

## Why FTS5 and not vectors

`kit memory search` uses SQLite FTS5 full-text search: it returns the row in
milliseconds and the agent reads the **raw text — zero loss, zero guessing**.
Embeddings are lossy, need a model call (which would break kit's deterministic,
zero-LLM core), and most setups never prove keyword search actually failed first.
Keyword search is the default; embeddings remain an explicit, opt-in escalation.

The search operation reads the local SQLite store and does not start memory
sync. `kit memory` commands also skip the post-command version notices, so a
memory search makes no network request at all. See
[`DATA_FLOW.md`](./DATA_FLOW.md#network-destinations) for the wider network
surface.

## Personal memory

```bash
kit memory index                      # build/refresh from ~/.claude transcripts
kit memory search <query> [--global]  # FTS5; defaults to the current project, --global = across all
kit memory stats                      # sessions / messages / tool-uses / size
kit memory suggest | <your-llm>       # BYO-LLM review: kit emits a prompt, never calls a model
```

Search is **project-scoped by default** (the git repo you are in) for relevance
and blast-radius containment; `--global` searches every project in your personal
store. The store is a single `~/.kit/memory.db` at mode `0600`.

### Switching agents and worktrees

Claude Code and Codex recall the same indexed history on a machine. Project-scoped
search, session-start recovery, and saved-thread listings include Git-registered
worktrees of that repository. For independently cloned copies, initialize one
checked-in association and commit it:

```bash
kit memory project init   # adds [memory].project_id to .kit.toml once
kit memory project show
```

Clones carrying the same UUID register their local roots in the personal store and
recall each other's history. The UUID is public association metadata, not identity
authentication; never copy it to an unrelated project. Without it, separate clones
are not merged by folder name or remote URL. An explicit subdirectory scope remains
limited to that subdirectory.
Curated shared files are still read from the current worktree, so another branch's
unmerged decisions do not silently replace this branch's decisions.

Pending-action lists, prompt hooks, recovery, and suggestions use the same registered
worktree set. The device filter remains in force: another device's items require
`kit memory pal list --all`. Legacy basename-only scopes still match for compatibility;
they cannot reliably distinguish separate repositories with the same directory name.
New actions use absolute project scopes. `kit memory suggest` does not release stale
claims or otherwise change the ledger, and labels recalled titles as stored data.

The persisted device ID is published atomically on first use, so simultaneous
local sessions adopt the same identity. Existing malformed identity files are not
silently replaced. If persistence fails, Kit uses a host/user fallback and
SessionStart reports degraded identity in both agent context and Claude's
user-visible `systemMessage`. This fallback is not stable across hostname changes
or restored persistence; inspect `pal list --all` before changing identity.

If private history or pending work cannot be read, SessionStart reports incomplete
recovery rather than treating it as an empty history. Curated shared decisions
remain independently recoverable. These diagnostics contain no raw database errors
or identity-file contents.

Health messages are passed separately from recalled text. Shared metadata and
transcript content cannot become user-visible health alerts by resembling a Kit
diagnostic. SQLite startup coordinates concurrent schema migrations; failed
migrations roll back and close their connection. WAL negotiation retries only
busy errors within five seconds. Longer contention still reports a failure, and
this budget is not a total timeout for opening or migrating a store.

Recall identifies the producing harness, original working directory, branch when
recorded, and timestamp. These are historical evidence, not proof that the current
checkout passes the same checks. Saving a thread still selects the latest session
in the current worktree; listing threads can show bookmarks from sibling worktrees.

Continuity depends on capture and transport, not on either model remembering a
previous conversation. Local transcript indexing is not a ChatGPT web connector.
Another machine or an ephemeral session needs the shared tier from Git and an
explicit private-memory transport for raw history. Imported history does not
transfer a harness's native resumable session files.

`src/memory/handoff.test.ts` exercises both transcript formats, idempotent indexing,
the real CLI, session-start recovery, saved threads, and unrelated-project isolation
using a temporary Git repository and linked worktree. It does not certify web
connectivity or cross-device transport.

`src/memory/pal-handoff.test.ts` exercises pending-action continuity through the CLI,
hooks, and suggestions while retaining project and device boundaries.
`src/memory/hook-health.test.ts` covers claimed-work recovery in both SessionStart
output formats; `src/memory/pal-claims-sync.test.ts` covers ownership-preserving
encrypted round trips in both encryption modes and explicit takeover after import.

**Multi-harness.** `kit memory index` is the lead-agent's store but pulls
transcripts from every supported coding agent on the machine, each tagged with a
`harness` so recall spans them: **Claude Code** (`~/.claude`), **Codex**
(`~/.codex/sessions`), **Gemini CLI** (`~/.gemini/tmp`), **Continue.dev**
(`~/.continue/sessions`), **Cursor** (`state.vscdb`), **Amazon Q Developer CLI**
(`amazon-q/data.sqlite3`), **AWS Kiro CLI** (`kiro-cli/data.sqlite3` — same
schema as Amazon Q, `conversations_v2` with a `conversations` fallback),
**Factory Droid** (`~/.factory/projects/**/*.jsonl` — Claude-Code-compatible JSONL),
**Aider** (project-local `$GIT_ROOT/.aider.chat.history.md` markdown, honoring
`AIDER_CHAT_HISTORY_FILE`), **Antigravity** (`~/.gemini/{antigravity-cli,antigravity-ide,antigravity}/brain/<id>/.system_generated/logs/transcript_full.jsonl` —
JSONL brain logs; the opaque protobuf conversation DB is ignored),
**Cline** (VS Code `saoudrizwan.claude-dev/tasks`), and
**OpenCode** (`~/.local/share/opencode` — SQLite `opencode.db` or the legacy
`storage/` tree). Absent agents are skipped silently. Adding one
is a single parser in `indexAllHarnesses()`. Each parser is built against the
agent's own serialization format (verified from its source), never guessed. The
Cursor + Amazon Q + Kiro parsers read app-internal SQLite defensively — if the
shape ever differs they index nothing rather than risk wrong data. (GitHub Copilot
CLI and Zed stay out until their formats are
source-verifiable: see the table in the repo notes.)

### Pending actions (PAL)

A structured "blocked-on-you" ledger on top of the raw log — items that survive
across sessions and **auto-close when their declarative verify check starts
passing**. A verify is a typed, native check, not a shell command. HTTP checks
still send requests; the fixed grammar is not a network authorization boundary:

```bash
kit memory pal                                   # list open items
kit memory pal list --status=claimed --json        # inspect owners of taken work
kit memory pal list --status=snoozed               # inspect postponed work
kit memory pal list --status=closed                # inspect completed work
kit memory pal add "ship the release" --verify-http https://example.com --expect 200
kit memory pal add "build artifact exists" --verify-file ./dist/cli.js
kit memory pal configure <id> --verify-file ./dist/cli.js # replace the target explicitly from this cwd
kit memory pal configure <id> --manual             # disable automatic verification, keep task state
kit memory pal release <id>                       # return a snoozed item to open
kit memory pal reopen <id>                        # explicitly reopen a closed item
kit memory pal done <id>                          # close unclaimed work; claims need owner + frontier
kit memory pal snooze <id> <days>                 # postpone unclaimed work
kit memory pal verify                            # run checks: N=2 consecutive passes closes; a regression reopens
kit memory pal import                            # migrate a legacy ~/.claude/pal/ledger.jsonl (verifies become manual)
```

**Claims and handoff:** read [Session-owned claims](MEMORY_CLAIMS.md) before claiming,
renewing, taking over, or changing claimed work, resolving competing histories, or
forgetting a task. That guide defines explicit session identity, frontier receipts,
legacy recovery and schema compatibility. Claims never expire automatically.

Supported verify checks: `--verify-http <url> [--expect <code>]` (kit makes the
request and compares the status) and `--verify-file <path>` (file exists). kit
never runs a shell verify. For a check these types do not cover, run it yourself
and close the item manually. Raw shell `verify_cmd` from pre-1.4 stores is never
auto-executed. Closing an automatic item does not disable its check: use
`pal configure <id> --manual` before manual closure when no automatic check applies.

Automatic checks require local approval in this implementation. Explicit `pal add`
with a check or `pal configure` creates a hash-only marker outside SQLite, under
`.kit-verifier-grants` beside the database. It binds the exact definition, portable
action ID, relevant creation root, physical database identity and local device.
The marker path is namespaced by store and device, so configuring a neighboring
restored store does not remove the source store's approval. Approval creation
establishes the device identity first; verification reads do not create one.

Encrypted snapshots carry the definition but not its approval. A restored or copied
database requires explicit `pal configure`, including an offline restore to the
same path on the same device. Existing rows are not automatically approved during
migration. Missing or mismatched approval reports `no-local-approval`, exits 1 and
leaves task state unchanged. `pal configure` owns its transaction and rejects an
enclosing transaction before changing approvals; manual mode remains available.

Schema 14 stores definitions in `verify_definition` and keeps the legacy
`verify_check` column null. Database triggers refuse older clients' attempts to
write that legacy column. The older typed verifier therefore sees no executable
checks, even after a current client approves one locally. Public `pal list` output
still exposes the definition as `verify_check`; this storage change does not rename
the public field. Same-file migration preserves existing valid local approval but
never creates it from a definition. Conflicting stored definitions refuse migration
without discarding either value.

Use a current client for verification. This does not retrofit old binaries working
on original pre-migration stores or protect against an account altering the database
and its guards. Historical backups with executable legacy fields require safe import
as described below. Disk-backed approvals require verifiable local file identity
and owner-only OS protection. Native Windows sets and re-verifies a non-inherited
ACL owned by the current SID with no other access entries; approval fails closed
if that cannot be proved. POSIX requires owner and mode checks. File identity
changes can require renewed approval. This is not protection against the owning
account or a whole-machine clone.

Original relative file checks resolve against the absolute creation directory,
not the caller's current directory, project scope, or recall aliases. A missing
or unbound creation directory is unavailable evidence, not a failed predicate.
`pal verify --json` reports these checks as `unverified` with an ID, reason and
recovery hint, and exits 1 without changing their state or passing streak. Invalid
stored checks and unavailable HTTP requests are also unverified. A determinate
false predicate is evaluated successfully and still exits 0; this maintenance
command is not itself a release gate.

Use `pal configure <id> --verify-file <path>` to repair or replace a target,
including after an explicit project move. Configuration resolves a relative path
to an absolute path in the configuring process's cwd; later callers cannot rebind
it implicitly. `--verify-http <url> [--expect <code>]` replaces an HTTP check;
the URL must be HTTP(S) and the status a whole number from 100 to 599. Exactly one
of file, HTTP, or `--manual` is required. Configuration resets the verification
streak but preserves lifecycle state, claim ownership, creation provenance and
portable identity. It can re-enable verification on a manual/imported item only
by supplying a new explicit definition; it does not trust an imported definition.
Read-only mode refuses configuration. Missing items exit 1; invalid options exit 2.

Verification results only apply to the local action version observed before the
check began. An intervening edit, claim, snooze, close/reopen, verifier change,
or another check that writes state invalidates that observation, including changes
through another SQLite connection. Queued checks also revalidate before starting;
this cannot undo a request already sent. `pal verify` reports invalidated queued
checks and rejected results as `stale`; a later verification can check the current
version. A passing streak does not clear
the next-check schedule. Local invalidation tokens are not portable causal history,
conflict resolution, or distributed claim ownership.
These guards coordinate ordinary writers; they do not protect against a database
owner altering the local version table or its triggers.

`list --status` accepts `open` (the default), `claimed`, `snoozed`, or `closed`.
Invalid or missing values are usage errors. Status selection retains the usual
project/device filters: `--global` expands projects and `--all` expands devices,
not statuses. These recall filters are separate from a claim's session owner.

Snooze accepts a positive whole number of days (default 7) within SQLite's
supported calendar. Expired snoozes return to open during ordinary open-item
listing and session recovery. Automatic reactivation only touches locally assigned
items within the requested project scope; `--all` permits inspection, not
maintenance of another device's work.
Legacy snoozes with missing or invalid deadlines also return to open.
`release` ends a snooze early; releasing claimed work requires its owner and current
frontier. Closing requires an explicit `reopen` to undo, unless an automatic
verification check regresses. Lifecycle commands exit 1 when their transition cannot
be applied and 2 for invalid input. Global flags do not replace positional values.

`pal list --read-only` does not migrate the store or reactivate work. It also
does not create a device identity; an existing identity is still used. This is
a stored-state view, so due tasks stay snoozed until a writable recovery runs.

Open items surface in the `UserPromptSubmit` reminder so handed-off tasks stop
getting forgotten. Declarative verification is operator-authored and executed
natively by Kit, never through a shell. Import does not activate a source check;
configuration must supply a new explicit local definition.

### Named copilots

Bookmark the sessions worth returning to under real names, instead of scrolling a
resume list labelled by whatever you happened to type first.

```bash
kit memory save "stripe-migration"     # bookmark the current session
kit memory threads                     # numbered list of saved copilots (--global for all)
kit memory resume <name|number>        # prints the Claude/Codex resume command
kit memory forget <name>
```

## Disaster recovery — a stolen laptop

The personal store is local-only, so back it up. `kit memory backup` writes an
**encrypted** blob (AES-256-GCM with a scrypt-derived key from a passphrase that is
**never stored**); put it anywhere — object storage, a USB stick, a private Turso
database.

Both encryption modes capture one committed SQLite snapshot, including WAL data,
without migrating or checkpointing the source. Temporary plaintext is held in a
private directory and removed after capture. Output is written to a new private
file before replacing the destination, so existing permissive file modes and
ordinary write/publication failures do not expose new plaintext or truncate the
previous output. Source aliases and SQLite sidecar aliases are refused. This is
not a guarantee of crash durability, cleanup after forced termination, or Windows
ACL isolation; those require separate platform evidence.

Current passphrase (`KITMEM04`) and recipient (`KITMEM05`) backups split the
snapshot into independently compressed and authenticated 1 MiB frames. Backup and
restore memory therefore stay bounded as history grows; declared plaintext size,
frame sizes, truncation, trailing bytes, and the 1 GiB decompression ceiling are
checked before publication. Compatible V1–V3 restores also decrypt and decompress
through bounded private staging files instead of loading the whole blob in memory.

Missing destination directories are created with private POSIX permissions after
successful encryption or decryption; existing parent permissions are not changed.
A failed decryption does not create destination directories. Restore refuses a
destination with SQLite WAL, SHM, or rollback-journal files, including with CLI
`--force`. Close database users and let SQLite finish recovery/checkpointing, or
restore to a new path. Do not delete sidecars to bypass this refusal: they may
contain committed history. This check does not acquire a cross-process lock;
replacement is an offline operation, even when no sidecars are present.

Raw restore inspects the decrypted staging database before replacing a destination.
Any non-null legacy `verify_check` or `verify_cmd` requires `kit memory sync <file>`
instead, regardless of the action's kind, status, or definition validity. Generated
and differently cased columns are included; view-backed or virtual pending-action
relations are not accepted for raw restore. Existing destination bytes remain intact
on refusal, and owned staging files and SQLite sidecars are removed. Accepted raw
snapshots are not migrated during restore.

Safe import is the recovery path for these historical backups in either encryption
mode: `kit memory sync <file>` decrypts into an owned temporary directory, scans the
incoming store, and merges it into the local store. Imported actions are manual,
without verifier definitions, grants, shell commands, or accumulated passes; existing
local actions and approvals are preserved. There is no CLI flag to bypass the raw
restore guard. Configure a new local check explicitly when one is needed.

```bash
# anytime
KIT_MEMORY_PASSPHRASE=… kit memory backup ~/Backups/brain.kitmem

# on a new machine
npm i -g sandstream-kit
KIT_MEMORY_PASSPHRASE=… kit memory restore brain.kitmem
kit setup                              # per repo: reinstall tools + materialize secrets from your vault
```

A wrong passphrase or a tampered blob fails closed (no plaintext is written). Note
that live harness resume (`claude --resume`, `codex resume`, etc.) is
machine-bound — the recovered store gives you back the searchable _memory_, not
the live session. Your **shared** project memory recovers for free with
`git clone`.

## Cross-device sync

Transfer personal-store snapshots between laptop, server, and ephemeral cloud
sessions. Same encrypted-blob mechanism as
backup, wired to a transport. **Opt-in** (no `~/.kit/sync.toml` → nothing happens),
and the remote **only ever sees ciphertext**. Current backups split the SQLite
snapshot into independently gzip-compressed and AES-256-GCM-authenticated 1 MiB
frames, keeping memory bounded during both upload and restore.

```bash
kit memory push          # encrypt + upload this machine's store to the hub
kit memory pull          # download + merge the hub's current snapshot into this machine
```

Config lives at `~/.kit/sync.toml` (LOCAL — never the repo tree, so a cloned repo
can't redirect your brain). The sync remote **must differ from the project's
`origin`** (anti-exfil guard). Two transports:

Git upload publishes one encrypted snapshot per commit. Concurrent pushes retain
both accepted tips as reachable merge parents, and pull replays every distinct
reachable snapshot before merging. History enumeration uses one streamed Git log,
a disk-backed deduplication index, and one ciphertext file at a time, so JavaScript
memory and process count stay bounded even for long histories. Publication is
verified by fetching the branch and proving the accepted commit reachable.
Command transports still carry only one latest blob and lack a verified receipt;
Git history can also be rewritten by a remote administrator. Keep independent
backups for disaster recovery.

```toml
# git transport — commit the blob to a SEPARATE private repo (any host, or self-hosted)
[memory.sync]
remote = "https://github.com/you/kit-memory.git"
branch = "main"
pull_on_start = true      # opt-in: hook pulls at session start
push_on_end = true        # opt-in: hook pushes before an (ephemeral) container is reclaimed
```

```toml
# command transport — bring your own move (S3 / rclone / scp / USB …)
[memory.sync]
transport = "command"
push_cmd = 'scp "$KIT_MEMORY_BLOB" you@server:kit-memory.enc'
pull_cmd = 'scp you@server:kit-memory.enc "$KIT_MEMORY_BLOB"'
```

### Project paths on another machine

A transferred transcript keeps its original working directory, harness, branch, and
session ID. Local recall uses a separate path alias; importing never pretends the
transcript was produced on this machine. Symlinked destination paths are resolved
locally. For a **single-project export**, explicitly rehome the whole import:

```bash
kit memory merge export.db --remap-project /home/me/projects/app
kit memory sync memory.enc --remap-project /home/me/projects/app
```

For a multi-project hub, use a local JSON mapping file instead. Longest source
prefix wins; unmatched and pathless messages are not guessed into another project.
Windows source paths are accepted alongside POSIX paths.

```json
[
  { "from": "/old-machine/projects/app", "to": "/home/me/projects/app" },
  { "from": "/old-machine/projects/tools", "to": "/home/me/projects/tools" }
]
```

```bash
kit memory sync memory.enc --project-map ~/.kit/projects.json
kit memory merge export.db --project-map ~/.kit/projects.json
kit memory sync init --remote https://github.com/you/kit-memory.git --auto --project-map ~/.kit/projects.json
```

For an existing sync setup, add mappings to its private `~/.kit/sync.toml`:

```toml
[[memory.sync.project_map]]
from = "/old-machine/projects/app"
to = "/home/me/projects/app"
```

Configured mappings apply to manual and session-start pulls. They never come from
the incoming database. Re-import repairs existing rows and reports scope repairs
separately from newly inserted messages. It preserves stronger sensitivity labels,
quarantine, tombstones, and locally changed bookmarks. Validation or database failures
roll back the import. Mapping a path does not restore native session files.

### Pending work on another machine

Pending actions have a portable identity separate from their short local display ID.
Import preserves the original device, project path, display ID, and initial claim
metadata. If another local action already uses the display ID, the imported action
gets an `import-...` ID instead of replacing or discarding either item. The portable
identity survives forwarding through another store.

Explicit project mappings apply to an action's original scope. A mapped action is
assigned to this device's local recall without changing its origin. Imported aliases
from a different machine are ignored. Without a mapping, foreign or unknown-device
actions require `kit memory pal list --all --global`; a missing origin is not treated
as this device. Imported actions are always manual: neither verification commands,
typed checks, nor accumulated verification passes are imported. `pal prune` does
not close them based on a foreign directory's absence.

Current state revisions carry explicit parents. Import preserves those revisions:
an observed descendant advances the task, while divergent concurrent heads remain
an unresolved conflict. The stored task row is only a deterministic display candidate
when conflicted, not a chosen winner. Open-work lists include conflicts even when that
candidate is closed or snoozed; `pal list --conflicts` narrows to those items.
Concurrent claims remain conflicted even when their owner labels and timestamps
are identical; equal values do not establish exclusive ownership.
SessionStart reports scoped conflicts in both the agent context and Claude's
user-visible system message, even when no new remote pull runs. Conflict counts
come from structured state, not recalled text; task titles remain stored data.

Use `pal show <id> --history --json` to inspect alternatives, session owners and the
current frontier. [Session-owned claims](MEMORY_CLAIMS.md) covers explicit takeover,
resolution, erasure receipts and schema 16 compatibility. Import preserves claim
ownership; project remapping does not assign the claim to the receiving session.
Secret and injection scans include historical state, even after its current text
has been corrected.

**Lossless concurrent transport remains incomplete.** Session ownership records and
frontier checks coordinate observed task state, not distributed external work. Git
snapshots do not guarantee that every offline writer has been observed.

Pre-identity database snapshots are imported as immutable, content-addressed snapshots
with a warning. Identical snapshots deduplicate, but edits cannot be recognized as
updates to the same action and may produce another item. Run a write-capable memory
command such as `kit memory index` with the current kit before exporting to establish
portable identity ahead of subsequent edits. Backup deliberately does not migrate
the source. No source store is rewritten by merge itself.

### Two encryption modes

- **Passphrase (default)** — AES-256-GCM + scrypt from `KIT_MEMORY_PASSPHRASE`.
  Simple, but _every_ pushing machine needs the same secret.
- **Public-key (recipient)** — for machines that can't safely hold a secret
  (**ephemeral cloud sessions**: no secret-store, no SSH key). Encrypt to a
  **public** key; only holders of the **private** key decrypt.

```bash
kit memory keygen        # X25519 keypair: private → ~/.kit/memory-key.json (0600),
                         # prints a shareable "kitmem-pub-…" recipient (NOT a secret)
```

```toml
[memory.sync]
remote = "https://github.com/you/kit-memory.git"
recipient = "kitmem-pub-…"   # public — safe in a setup script, env var, or committed
pull_on_start = true
push_on_end = true
```

With a `recipient` set, push needs **no passphrase**. Copy `~/.kit/memory-key.json`
only to the durable machines that must decrypt (laptop, server). Under the hood:
a fresh ephemeral X25519 keypair per blob → ECDH → HKDF-SHA256 → AES-256-GCM
(libsodium sealed-box shape, pure `node:crypto`, zero deps; current blob magic
`KITMEM05`, with `KITMEM03` accepted for compatibility).

### Ephemeral capture prerequisites

An ephemeral environment can contribute encrypted memory when it exposes a
supported transcript format, can run Kit and its capture hooks, and has authorized
access to the private hub. Recipient encryption needs no decryption secret in that
environment; uploading still requires transport credentials. Provision the private
sync configuration through that environment's setup script, then verify capture,
upload and recall on a durable machine before relying on it. Local harness tests
do not certify browser-hosted lifecycle capture. ChatGPT web can call kit's MCP
tools through `kit mcp web`, but that outbound tunnel does not expose or transfer
ChatGPT's native conversation transcript. `push_on_end` is best-effort:
abrupt teardown can prevent capture or upload, so retain independent backups.

## Shared memory

See [Shared memory](MEMORY_SHARED.md) for team curation, receipts, secret scanning,
and the committed `.kit/shared/memory.jsonl` format.

## Security model

- The personal store is secret-dense (it indexes your real transcripts). It lives
  only under `~/.kit/` at `0600` and is never committed or synced unencrypted.
- `kit memory scan` walks every text cell for secrets (reusing kit's
  `SECRET_PATTERNS`) — gitleaks and most scanners only see text files, not SQLite
  cell contents. It reports masked findings and exits non-zero if any are found,
  so you can use it as a gate.
- Backups are encrypted (AES-256-GCM, scrypt). The passphrase is never stored.
- Shared writes are secret-scanned fail-closed. Verify checks are declarative
  and typed (no shell), and a verify imported or merged from another store is
  demoted to a manual item, so no executable ever crosses a file, DB, or sharing
  boundary and auto-runs.

## Where it sits

`kit memory` is part of kit's deterministic **core** (zero model calls, local-first).
The storage backends are **modules**: SQLite is the default; an encrypted backup
blob is the portable transport, and opt-in cross-device sync (git remote or your
own command — see [Cross-device sync](#cross-device-sync)) and an opt-in embeddings
escalation layer on top without changing the core.

## Credits

The schema and two-hook design are derived from **cloudctx** by chadptk1238
([github.com/chadptk1238/cloudctx](https://github.com/chadptk1238/cloudctx), MIT) —
a Bun-native SQLite memory for Claude Code. kit's implementation is independent
(Node/TypeScript, `node:sqlite`) and adds multi-harness support, project scoping,
a two-tier personal/shared split, secret-scanning, encrypted backup, and PAL. With
thanks for the original idea.
