---
id: ADR-0010
title: No AI slop — kit adopts the manifesto, and says which parts a gate holds
status: accepted
enforced_by: [src/agent-review-gate.test.ts, src/review-protected-paths.test.ts, src/prepush-script.test.ts, src/memory/write-gate.test.ts]
---

# ADR-0010: No AI slop

## Decision

kit adopts **No AI Slop: A Manifesto** (slopmanifesto.com, written by the speakers and attendees
of AIE Code Summit 2026) as a standard for how kit itself is built, mostly by agents.

> *"Slop is when we put less effort into producing something than we ask the consumer to spend
> understanding it."*

Most of the manifesto is values. A value an agent can ignore is the false green this repository
exists to remove. So this ADR does not stop at *"we agree"*. Each resolution below is marked as one
of:
- **held by a gate**, naming the gate and the test that pins it;
- **practice**, a rule in `CLAUDE.md` that only a person or an agent upholds;
- **open**, a gap with the gate that would close it.

The manifesto's own last line applies: *"None of us has this figured out."* This table changes as the
gates do.

## Resolutions, measured against kit

| Resolution (abridged) | kit today | Held by |
|---|---|---|
| *"A swarm of agents can produce more work in a single day than a person can review in our lifetime"*; slop is asymmetric. | **Gate.** `scripts/agent-review-gate.mjs` refuses a gate-only approval over `MAX_CHANGED_LINES` (1,500). A larger change needs a person. | `src/agent-review-gate.test.ts` |
| *"Agent reviews, linters, and verifiers are useful but not sufficient … we still review at least some subset … What subset depends on the stakes."* | **Gate.** The stakes are written down: `.github/kit-protected-paths.json` names the guardrail paths. A pull request touching one is never approved by the bot and needs the owner. The bot's own approval says *"it does not judge what the change is for"*. | `src/review-protected-paths.test.ts`, `src/agent-review-gate.test.ts` |
| *"When a mistake shows up twice, we … improve the system and its guardrails. Anything a linter, type checker, or automated check can catch, we let it catch."* | **Gate.** This is kit's method: baseline-frozen standards (only new findings fail), the ADR gate (`adr check` fails CI), a test per new source file, and a regression test that fails without each fix, as the PRs in this repository record. | `src/prepush-script.test.ts`, `docs/adr/0001`–`0009` |
| *"What shipped … matters FAR MORE than lines of code, prs merged, tokens spent."* | **Design.** `kit usage` is deliberately not a token or money report. It reports the denominator: checks enumerated, checks that could not run, refusals (`src/commands/usage.ts`). | the module's contract; no test pins the absence of a metric |
| *"Slop compounds. The more slop sits in our knowledge base … the more of it the next agent reads and copies."* | **Gate, partial.** The memory write gate screens a row for injection and plaintext secrets before it is stored, and `kit triage instructions` reports instruction lines that hand authority elsewhere. Neither judges quality. | `src/memory/write-gate.test.ts` |
| *"When an agent wrote something we're sending, we make that clear."* | **Practice, unenforced.** 271 of the last 300 non-merge commits on `main` carry a `Co-Authored-By: Claude` trailer, and PR bodies end with the Claude Code footer (`CLAUDE.md`). Nothing checks either. | **open**: a check that a commit pushed from an agent session carries the trailer |
| *"We own the intent, taste, and consequences of what we ship."* / *"We do our own thinking."* | **Practice.** Every PR body states Why, Change and Testing, and names what was not verified (for example *"only Linux was run"*). That is checked by review, not by a gate. | review |
| *"When someone sends us slop, we tell them, kindly."* | **Practice.** | review |
| *"Unreviewed output isn't always necessarily bad."* | **Agreed, scoped.** Gate-only approval is the unreviewed path, and it is bounded by size and by protected paths. Research notes in `kit-research` merge on supply-chain checks alone. | the two gates above |

## Consequences

- An agent working in this repository treats the **open** row as a known gap, not as permission.
- A new guardrail that comes from a repeated mistake is added as a test, and this table gains the
  row. That is the manifesto's *"improve the system"*, written so it can be checked.
- This ADR has **no `kit-enforce` block**. None of the resolutions is an import or a line pattern,
  which is all the grammar can express. The rows marked *gate* name the tests in `enforced_by`, and
  `adr check` fails if one of those files is missing.

## Not decided here

- Whether kit should **ship** a slop check to its users, for example a review-gate size limit or a
  disclosure check as a `kit check` row. This ADR governs kit's own repository.
- The disclosure check itself (the **open** row). It needs a reliable signal that a commit came
  from an agent session, which kit does not have today.
