# Fast gate startup: make the per-tool-call gates start fast in TypeScript

> Steps use checkbox (`- [ ]`) syntax for tracking. Each phase lands as its own PR with green
> CI (Linux and Windows) before the next starts.

Status: OPEN

**Goal:** Cut the start-up cost of `kit gate-bash`, `kit gate-env` and `kit gate-egress`, the hooks
that run on every agent tool call. Change no gate decision and keep every deny path fail-closed.

**Why:** research in `sandstream/kit-research/docs/research/kit-rust-rewrite-vs-kit.md` (#233),
measured on kit 7.6.0 (`abb3e592`), Linux, median of 40 runs:

| Variant | gate-bash | gate-env |
| --- | --- | --- |
| today, through `dist/cli.js` (loads 682 modules) | 350–400 ms | 350–400 ms |
| same handler without `cli.js` | 119 ms | 57 ms |
| plus Node's compile cache | 92 ms | 50 ms |
| plus a V8 startup snapshot of a gate-only bundle | 68 ms | 45 ms |
| native floor (trivial Rust/Go program) | 2.4 ms | 2.4 ms |

Of 386 ms, about 21 ms is kit's own work; the rest is loading `cli.js`. The owner decided on
2026-11-26: **no Rust rewrite**; do the TypeScript work below. A native gate is reconsidered only
under the criteria in Phase 5.

## Rules for whoever implements this (Codex or Claude)

- Read `CLAUDE.md` / `AGENTS.md` first; follow its cross-platform, changelog-fragment and prepush rules.
- **Fail closed.** Any fault before a gate decision ends in **exit 2** with a deny the harness reads.
  Exit 1 is *allow* for Claude Code PreToolUse. A test proves this for every new entry point.
- **No behaviour change.** The deny/allow verdict and message for every payload in the existing gate
  tests must be identical before and after. Add a differential test that runs the same payloads
  through `cli.js` and the new entry and compares exit code and output.
- ADR-0001 (no model client), ADR-0002 (no new runtime dependency), ADR-0006 (`src/utils/**`
  imports nothing from the repo). Run `node dist/cli.js adr check`.
- Protected paths (`.github/kit-protected-paths.json`): `src/commands/gate.ts`, `src/agent-config.ts`,
  `src/install-gate*`, `src/opencode-gate*` and others. A PR that touches them is the owner's to
  merge; keep the unprotected part in its own PR where possible.
- CCN ≤ 15, functions ≤ 80 lines, files under their frozen size (`.kit-baseline.json`
  `size_metrics`), and **no test `describe` block over 80 lines**: main went red twice on that.
- Never skip hooks; never `git stash`; commit messages end with only the `Co-Authored-By` line for
  the agent that wrote them, with **no session URL** (CI checks commit messages).
- Windows: no shell, `node:path` everywhere, `.cmd` shims handled (see `src/utils/win-npm-shim.ts`).
  macOS is unverified by CI; say so in each PR.

## Phase 0 — prerequisite

- [ ] The fail-open fix for the gate's catch (research error E3: `runGateFailClosed` loads `node:fs`
  dynamically on its deny path, so a module-load fault exits 1) is merged. Its PR is open from the
  Claude session as `…-protected-gate-deny-failclosed`. Build on it, not around it.
- [ ] The lazy `node:sqlite` load (research error E1) is merged (`…-lazy-sqlite`).

## Phase 1 — a slim gate entry (protected)

- [ ] Add `src/gate-entry.ts` → `dist/gate.js`: parses `gate-bash|gate-env|gate-egress`, reads
  stdin, calls the same handlers `src/commands/gate.ts` uses, and never imports `src/cli.ts`.
- [ ] `kit gate-bash`, `kit gate-env` and `kit gate-egress` through `cli.js` keeps working and delegates to the same handler (one code path).
- [ ] Wire the hooks to the slim entry: `kit agent-config` (`src/agent-config.ts`), the portable
  gate entries, the `~/.kit/bin/kit` wrapper and the Codex/Cursor/Droid/… gate files kit writes.
  Old hook entries pointing at `kit gate-bash` and the other gate verbs keep working.
- [ ] A test that fails if `dist/gate.js` statically reaches `cli.js`, `node:sqlite` or `zod`
  (walk the import graph of the built file).
- [ ] The differential test (Rules) plus a fail-closed test that breaks a module load in the slim entry.
- [ ] `scripts/bench-gates.mjs`: median and p95 over N runs for both entries; prints, never gates CI.

## Phase 2 — Node compile cache

- [ ] Enable `module.enableCompileCache()` in the slim entry only, with the cache under kit's
  per-user state dir. A missing, corrupt or unwritable cache must never change a verdict or fail
  the gate (test: a read-only cache dir and a garbage cache file).

## Phase 3 — ship what is tested

- [ ] A CI job (Linux and Windows) that runs `npm pack`, installs the tarball into a temp prefix,
  and runs every gate deny case through the **installed** binary and the wired hook command.
  Research gap G3: naive single-binary builds failed open in 2 of 3 tries; nothing tested what ships.

## Phase 4 — measure on Windows

- [ ] Run `scripts/bench-gates.mjs` on the Windows runner and record the numbers in this plan.

## Phase 5 — decide on the next step (owner)

- [ ] If gate p95 is still **over 150 ms on Linux or 300 ms on Windows** after Phases 1–2: build a
  V8 startup snapshot of the gate bundle.
- [ ] If still over after that, or a harness sets a per-call budget under ~2 s: a native gate for
  **non-install** commands only, with the differential test as its contract. Otherwise stop here.

## Not in scope

- A Rust (or Go) rewrite of kit: 2.7–7.1 engineer-years, 70–150 crates against kit's 2 runtime
  packages, and 95 % of the 1,250 test files are white-box (research, measured).
- Single-binary distribution (Node SEA, Bun, Deno): breaks 28 install-relative file reads and 15
  Node re-spawns (research gap G2). Separate plan if ever wanted.
