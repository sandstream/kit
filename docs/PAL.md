# PAL — Pending Action Ledger

A single **global** ledger of "blocked-on-you" action items that survives across
sessions and repos, surfaces at the start of every agent session, and
**auto-closes** the moment an item's verify command starts passing — so handed-off
tasks stop getting forgotten.

PAL is a zero-dependency Python script (`scripts/pal`, stdlib only). It is
deterministic, local-first, network-free and **fail-open**: a broken verify
command or a corrupt ledger line can never break the session hook that calls it.

## Why

When work is handed off — to a teammate, to a future you, or to an agent — the
follow-up is what gets dropped. "I'll re-enable that flag once the migration
lands." "Ping me when the deploy is green." PAL makes each of those a tracked
item with an attached **verify command**. Instead of you remembering to check,
PAL runs the check and closes the item itself. Items that are never resolved get
louder over time (stale → decide) so nothing rots silently.

## Storage

```
~/.kit/pal/ledger.jsonl
```

Append-only JSONL, created `chmod 600` in a `chmod 700` directory. State is the
**fold** of all lines: records are grouped by `id`, merged in order, last field
wins. There is no compaction step and no in-place mutation — every change is a
new appended line, which keeps the format crash-safe and gives a full audit
trail. Do not sync this file across machines.

## Commands

```
pal add --title T [--why W] [--owner user|agent|other] [--repo R] [--verify CMD]
pal list [--all]
pal done <id>            mark resolved by hand (the only path for verify-less items)
pal snooze <id> <Nd>     hide until N days from now
pal drop <id>            abandon (hidden, kept for audit)
pal verify-all           run due verify commands, auto-close / backoff (no output block)
pal surface              verify-all + print the compact open block (for the SessionStart hook)
```

### Adding an item

```bash
# Self-verifying: PAL will auto-close once the endpoint returns 200
pal add --title "Re-enable rate limiting on /api/login" \
        --why "disabled during the incident" \
        --verify 'curl -fsS https://your-app.example.com/api/health'

# Manual: no verify, you close it with `pal done` when it's handled
pal add --title "Ask security to rotate the staging key" --owner other
```

`--repo` defaults to the basename of the current git repo. `--owner` defaults to
`user`; agent-owned items are hidden from the "blocked on YOU" surface so agents
can track their own follow-ups without spamming you.

## Auto-close: the correctness core

The attached `verify` command is the contract: **it must exit 0 if and only if the
action is genuinely done.** `pal verify-all` (and `pal surface`) run the due
verifies and transition each item by the result:

| verify result | meaning | PAL action |
|---|---|---|
| exit 0 | done | count a pass; close after **2 consecutive** passes |
| non-zero (not 127) | not done yet | reset pass streak, exponential backoff (60 min → 24 h cap) |
| timeout / hung | no information | retry soon (~10 min), show item as `(unverified)` |
| exit 127 | the verify itself is broken (command not found) | treat as no-info; flag `⚠verify-broken` after repeats |

Key guarantees:

- **N=2 consecutive passes** are required before closing. A single flaky-network
  success cannot close an item; the confirming re-check runs on the very next
  pass so confirmation is still fast.
- **Backoff** means a not-yet-done item is not re-run on every session — it backs
  off up to 24 h, so the hook stays cheap.
- **Reopen-on-regress**: a closed item is still re-checked periodically. If its
  verify later fails, the item resurfaces as `↩regressed` — turning the ledger
  into a lightweight live health-check, not just a to-do list.
- **Fail-open everywhere**: a broken verify, an unlaunchable shell, or a corrupt
  ledger line is swallowed; `pal surface` always exits 0.

Budgets keep it bounded: each verify is capped at 8 s, and a whole
`surface`/`verify-all` run is capped at ~15 s total.

## Surfacing at session start

`pal surface` prints a compact block of the items **owned by you** (agent-owned
items are summarized as a hidden count), plus what changed this run:

```
[PAL · 2 open — blocked on YOU]
  ! 3f9a    your-app   Re-enable rate limiting on /api/login  · auto
  ! a1c2    infra      Ask security to rotate the staging key · manual ⏳STALE 9d
  (1 agent-owned hidden · ✅ 1 auto-resolved this session · close: pal done <id> · snooze: pal snooze <id> 7d)
```

Wire it into your agent's **SessionStart** hook so the ledger greets you every
session. kit ships ready-made templates under `examples/agent-hooks/` for Claude
Code, Codex, Cursor and Cline — point the SessionStart entry at `scripts/pal
surface`. An empty ledger prints nothing (silent when there's nothing to do).

Items age: after `STALE_DAYS` (7) they show `⏳STALE`, and after `DECIDE_DAYS`
(21) they escalate to `🔴 decide: do it or pal drop` so undecided work can't hide
forever.

## Tuning

The constants at the top of `scripts/pal` are the only knobs:
`VERIFY_TIMEOUT`, `BATCH_BUDGET`, `CLOSE_STREAK`, `BACKOFF_START`, `BACKOFF_CAP`,
`NOINFO_RETRY`, `DONE_RECHECK`, `STALE_DAYS`, `DECIDE_DAYS`. Defaults are chosen so
the SessionStart hook stays well under a second in the steady state.

## Roadmap: a native `kit pending`

The v1 ships as a bundled Python script so it works with zero build step. The
better long-term home is a native `kit pending` subcommand, which would let PAL:

- read repo/project context from `.kit.toml` instead of shelling out to `git`,
- gate destructive verifies behind kit's TOTP elevation,
- be wired into the same managed SessionStart block kit already writes into
  `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `.clinerules`,
- ship cross-platform without a Python dependency.

Until then, `scripts/pal` is the supported entry point.
