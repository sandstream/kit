---
id: ADR-0007
title: kit owns the rig, never the judgement — measuring model + kit residual risk
status: accepted
---

# ADR-0007: kit owns the rig, never the judgement

## Decision

kit may measure how well a model performs **together with kit's gates**, and may publish
that measurement. Specifically, kit owns:

- the **frozen input** — a pinned commit plus a pinned prompt/rubric, content-hashed, so
  two runs are answering the same question;
- the **ingest schema** — a model's findings arrive as structured rows (file, line, claim,
  severity) attributed to model, version and date;
- the **deterministic adjudication** — whether a claimed defect is real is decided by the
  repository (test suite, mutation harness, broker denials), never by a model;
- the **arithmetic** — overlap, divergence, caught/missed counts, drift across runs;
- the **receipts** — the same signed, replayable evidence trail every other kit verdict
  carries.

kit does **not** produce a review, rank models by preference, score a judgement's quality,
or call a model at any point. The models run outside kit and hand their output in.

## Rationale — this is about kit's own residual risk, not benchmarking

The earlier framing was that model-vs-model comparison is mush because the judge is
another model. True, but it made this look like a nice-to-have. The real motive is
narrower and more uncomfortable.

**kit's green is a claim about kit's floor, and readers take it as a claim about the
work.** Measured on this repo: `kit check` runs 42 checks, of which **41 inspect the code
and 1 executes it**. kit lives almost entirely in the static tier.

Multi-tier verification research ([arXiv:2607.00107](https://arxiv.org/abs/2607.00107) —
8,918 C++ programs across 851 tasks, four tiers, three models plus human-authored code)
found:

> *"AI-generated code is roughly twice as likely as human code to trigger a confirmed
> runtime violation, even after controlling for code length and test pass-rate."*

and, critically, that under **static analysis the two appear equally safe** — a similarity
the authors call misleading. The tiers detect largely different classes of violation; no
single tier suffices.

So on a weak model, `kit check` passing says approximately what it would have said about
human-written code. That is not a false verdict, it is an **uninformative** one presented
in the same colour as an informative one. Without a residual-risk number we cannot say
what our own green is worth — and a governance tool that cannot say that is asserting
trust it has not earned.

## Why this does not break ADR-0001

The zero-LLM contract forbids a model call **in the gate loop**, because that would make
the verdict probabilistic, add egress to the trust boundary, and put a prompt-injection
surface inside the security tool. None of that applies here:

| step | actor | deterministic? |
|---|---|---|
| produce the work | the model, outside kit | no — and it is not a verdict |
| run the gates | kit | yes |
| decide whether a finding is real | the **repository** | yes |
| count, difference, report | kit | yes |

No SDK import in `src/**` — which ADR-0001's `forbid_import` rule already enforces, and
which is the mechanical half of this decision. No model judgement decides a pass or fail.
The output is reproducible from the frozen input.

**The precedent is already shipped.** `kit triage` scores a third-party package
deterministically, publishes a claim about code kit does not own, and gates an install on
it — failing closed when it cannot verify rather than passing on thin evidence. This is
`kit triage` pointed at the agent instead of the package.

## Relationship to ADR-0004

ADR-0004 rules that model-shaped work — grilling, specs, review framing — lives above
kit, and that a feature needing a model judgement to decide pass/fail stays out. This ADR
does not weaken that. It draws the line one notch more precisely:

> **Producing or grading a judgement is model-shaped and stays out. Framing the question,
> receiving the answer, and adjudicating it against the repository is substrate, and is
> kit's.**

If those two ever conflict in practice, ADR-0004 wins and the rig is wrong.

## Consequences — three limits that ship with the number, not with its documentation

Any residual-risk figure kit emits must carry these in its own output. Without them the
measurement becomes the false comfort it was built to remove.

1. **Lower bound only.** You can measure only what you can seed. Defects nobody thought to
   inject are invisible. The number is a floor on risk, never a ceiling, and must never be
   phrased as a safety score.
2. **Goodhart.** The moment a defect corpus exists it becomes the thing that gets
   optimised against. It has to rotate, and it must never be published as a benchmark.
3. **Transfer is unproven.** The 2× above is C++ competitive programming. The direction
   transfers — static analysis cannot see what execution can — the constant does not, and
   quoting it as kit's own figure would be borrowed precision.

Also: **`kit check` now states its scope next to its verdict** (`tierNotice`,
`src/cli-checks-shared.ts`), counted from the checks that ran rather than asserted, so the
narrowness above is visible without needing this rig at all. That was the cheap half of
the fix and it shipped first.

## Status of enforcement

This ADR carries **no `kit-enforce` block**, and that is deliberate rather than an
oversight: its mechanical half is already ADR-0001's `forbid_import` over `src/**`, and
duplicating it here would give two rules that can drift apart. What this ADR adds is a
boundary that a human applies in review — which is why it is listed as *documented, not
enforced*, and why building the rig before this file existed would have been the erosion
it guards against.
