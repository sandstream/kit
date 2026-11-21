# Direction: one order of work for kit

Date: 2026-11-21
Status: proposed. Nothing here is decided until Peter accepts it.
Requested by Peter: "take all plans and make a new one from here".

## What this file is

kit has 17 plans. Five are finished and still listed as open. At least three are older than the
code. None of them says which plan goes first. This file gives one order.

- This file owns the **order** and the **choice** of what is not done now.
- The source plans keep their rows, acceptance criteria and receipts. A row is named here by its
  id (`Z11`, `TN1`, `P3`) and is not rewritten.
- Every earlier decision stands. The deferrals of 2 November 2026 (`L4b`, `L4c`, `P3`, `P5`) are
  recorded below with their triggers and are not reopened by this file.
- Peter merges every pull request. Nothing in this file changes that.

## The principle

Trust no one. The trust-no-one plan states it as a rule that can be tested:

> Make every security claim traceable to a tested boundary.

A scanner that finds nothing, a signature that validates and a gate that is installed are not
proof by themselves. This gives one question for every row and every new idea:

> Who or what must be trusted for this to be safe, and which tested boundary replaces that trust?

## Roles

- **Peter decides direction.** He chooses the goals, sorts new ideas and accepts ADRs.
- **Agents build and prepare.** An agent may draft a sorting record or a plan row. It does not
  choose a goal.
- Delegation of merges is a later decision (see "Delegation"). It rests on evidence, not on
  trust in an agent, in a reviewer or in kit.

## Goals

### Goal 1: every security claim traces to a tested boundary

In this order. A row marked **owner** needs Peter's decision before work starts.

1. **The evidence store holds.** A log that cannot be verified breaks the principle directly.
   - An audit event can be lost with only a line on stderr. When the write lock times out,
     `appendAuditEventDirect` returns false. Some callers check the result, others ignore it.
     This is the open defect, on every platform.
   - Windows reaches the timeout first (PAL `c6c5`): under 8 writers the 5 second wait expires,
     because each anchored append starts PowerShell about three times while it holds the lock.
     Shipped as a known limit in 7.3.0. **owner**: a design decision is needed.
   - Closed, listed here because the action list still shows it: duplicate previous hashes
     under concurrent appends (PAL `e49b`). The read of the previous hash is inside the lock,
     and the four tests in `src/audit-write-lock.test.ts` pass.
   - `TN6`, evidence store integrity: a broken log is kept byte for byte and reported.
   - The audit log and its anchor are never changed without Peter's decision.
2. **`TN0`**: malformed, partial, stale, unsupported, missing and complete-empty evidence are
   separate outcomes. Only the last supports "no findings".
3. **`TN1` with `TN2`**: bind approval to the bytes that run, and prove the isolation of the
   actual workload. The incoming-trust work owns the implementation.
4. **A missing or failed required gate never passes.** Modules plan, phases 0, 1a and 1b. The
   plan exists only on a branch that is 757 commits behind `main`. Its baseline must be redone
   before phase 0 starts.
5. **Zero trust, rows with no approval need**: `Z15` proof of use (the `enforcement evidence`
   row exists, the rest is open), `Z10` remainder, `Z11`, `Z13`.
6. **`TN3`, `TN4`, `TN5`**: limits on prompt injection and MCP authority, the identity and
   revocation lifecycle, and the published coverage matrix.
7. **Trusted memory pull**: the rest of `T0`, then `T2` and `T3`.
8. **Zero trust, rows that need approval or a credential**: `Z2`, `Z3`, `Z7`, `Z8`, `Z9`, `Z12`,
   `Z14`. **owner** for `Z8`, `Z9`, `Z12` and `Z14`.

### Goal 2: kit gets smaller

1. **Close what is finished.** Archive the plans for agent trifecta, multi project, upstream
   watch and rig. Check that `kit health` does what its plan says, then archive that plan too.
   Bring three plans up to date with the code: few dependencies (phase 2 has shipped), zero
   trust (`Z6` is at least partly built) and catch-up refactor (phase B has shipped).
2. **Clean the action list.** About 29 of the 52 open items are one warning repeated from old
   worktrees. They hide about 10 real defects. **owner**: Peter names the worktrees to remove.
3. **Few dependencies**: the phase 3 decisions (ESLint with `typescript-eslint`, the image's
   bundled picomatch), phase 4, and the state of phase 5. **owner** for phase 3.
4. **Same tools in the cloud session, on the Mac and in CI**: phases 1 and 3. Phase 2 is
   **owner** only. Until then Semgrep does not run in the local gate.
5. **Node runtime policy**: phases 2 to 5. Phase 6 is bound to 2027-04-30.
6. **Flaky tests**, by the rule in `TN6`: a rerun is not evidence. Open: PAL `3e37`, `ac1e`,
   `88f0`, and three seen on 2026-11-20 (two on Windows, one in the memory tests).
7. **Catch-up refactor**: the rest of `R1`, then `R2`. `R3` and `R4` wait (see "Parked").
8. **September fix plan**: sort the 88 untriaged findings of phase 4. Each one becomes a row
   in this file, a documented limit, or a closed finding. **owner**: `PAL-WT-2`.

### Goal 3: one new capability at a time

Peter picks one, or none. Nothing in this list starts without that choice.

| Candidate                                                 | State                      | Source                |
| --------------------------------------------------------- | -------------------------- | --------------------- |
| Files and secrets in the repo as ciphertext per recipient | ADR-0011 proposed, PR #962 | this session          |
| A decision has an owner who can be consulted              | idea, no ADR               | this session          |
| Scope tripwires                                           | phase 0 step 1 done        | scope tripwires plan  |
| Layered coverage `L4a` acceptance and `L5`                | open                       | layered coverage plan |
| External alerts as input (`Z12`)                          | open, needs an ADR         | zero trust plan       |

## Sorting new ideas

An idea is compared with kit and gets a place. It is not thrown away.

| Place                      | The idea belongs there when                                                |
| -------------------------- | -------------------------------------------------------------------------- |
| kit core                   | every user needs it, it is deterministic, and a failure must stop the work |
| module in kit              | it uses kit's rig and is optional. It can fail without weakening the floor |
| plugin                     | it serves one service or environment and needs its own release pace        |
| above kit (agent or skill) | it needs a model or a judgement (ADR-0001, ADR-0004)                       |
| new product                | it has another user, or it stands without kit                              |
| parked                     | no goal carries it now. It gets a trigger for when it is read again        |

Each idea gets a short record: where it came from, the goal it serves, its place, and the answer
to the question under "The principle". "New product" asks the most, because each product is one
more system that Peter owns.

First records, as proposals:

- **Ciphertext per recipient.** Today a repository trusts every reader and the git host with
  plaintext. Per-recipient encryption removes that trust, so the idea is close to kit's
  principle. Place: module in kit or new product. Not decided.
- **An owner per decision.** It splits in three. The gate and its receipt belong in the core
  (the PR review plan builds them). An owner agent that researches and answers belongs above
  kit. The way of organising the work may be a new product.

## Delegation

Peter wants to decide direction and not approve each change. What was measured on 2026-11-21:

- The last 50 merged pull requests were merged in four days.
- Sorted by the files they touch: about 27 need Peter (keys, audit log, CI workflows, ADRs,
  dependencies, gate configuration and the agent gates), about 22 could be decided inside one
  area, and 1 is documentation only.
- 11 of the pull requests change the agent gates. An agent must not merge a change to the gates
  that limit agents.

The mechanism for delegation without trust already has a plan: a review receipt bound to the
head commit (`P1`, merged), a second identity (`P4`, built) and a merge rule that requires the
receipt (`P3`, deferred). Delegation therefore depends on a row that is deferred. This file names
that tension. It does not reopen the decision.

## Parked, each with its trigger

| Row                                  | Why it waits                          | Read again when                                   |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------- |
| `P3`, `P5`                           | decision of 2 November                | the gate reads receipts, or merge denials persist |
| `L4b`, `L4c`                         | decision of 2 November                | the trigger recorded with that decision           |
| `R3`, `R4`                           | need a decision from Peter            | `R1` and `R2` are done                            |
| modules plan, phases 2 to 6          | goal 1 takes only phases 0 to 1b      | phase 1b is done                                  |
| owner agents, the organisation model | no ADR, and delegation is not decided | Peter accepts an ADR for decision owners          |
| building ADR-0011                    | it is a goal 3 candidate              | Peter picks it                                    |

## Decisions for Peter

1. Is the order of goal 1 right, with the evidence store first?
2. Which worktrees may be removed (goal 2, row 2)?
3. Which goal 3 candidate, if any?
4. Where does ciphertext per recipient belong: module in kit or new product? This decides what
   happens with PR #962.
5. The design decision for the Windows audit lock (`c6c5`).

## Not verified

- The state of each plan comes from two agent readings on 2026-11-21. Only these were checked
  by hand: PRs 806, 807 and 808 are merged, the trust-no-one plan was read in full, and the
  phase tables of the zero trust, modules and PR review plans were read.
- That `kit health` does what its plan says.
- How many phase 3 rows of the September fix plan are closed.
- The sorting of pull requests looked at file paths. It did not read the changes.
- The count of about 29 repeated warnings and about 10 real defects is from reading one list.

## Source plans

In `docs/plans`: kit-health v1a, kit-rig v1, node runtime policy, cloud local parity, scope
tripwires, few dependencies. On unmerged branches: kit modules plan (`codex/kit-modular-plan`),
trust no one boundaries (`docs/trust-no-one-plan`). Outside the repository, in the owner's
working folder: agent trifecta, catch-up refactor, September fix plan, layered coverage, trusted
memory pull, multi project, PR review process, upstream watch, zero trust.
