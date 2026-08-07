---
id: ADR-0004
title: Agent workflow skills operate above kit
status: accepted
---

# ADR-0004: Agent workflow skills operate above kit

## Decision

kit owns the deterministic floor for agent work: checks, gates, policy, secrets,
supply-chain triage, locks, signatures, receipts, memory indexing, and
cross-runtime placement/liveness. Agent workflow skills, including
`mattpocock/skills`, own the model-shaped work above that floor: grilling,
domain modeling, specs, tickets, TDD discipline, debugging loops, code review
framing, and handoff.

Skills may call kit. kit must not absorb workflow skills as core commands unless
the behavior can be verified without a model and belongs on the action or review
path.

## Rationale

This keeps the zero-LLM contract intact while letting teams adopt strong agent
workflows. The skill layer can change quickly and encode taste. kit stays the
portable, testable substrate that proves facts: what is installed, what is
triaged, which secrets resolve, whether hooks are live, which gates ran, and
what changed.

The interface should be small and stable. A skill should be able to call commands
such as `kit context --json`, `kit memory search`, `kit triage`, `kit pkg`,
`kit secrets set --stdin`, `kit map --json`, `kit check`, and `kit review --json`
without needing to know kit internals.

## Consequences

- Do not add core workflow commands named `grill`, `to-spec`, `to-tickets`,
  `implement`, or similar.
- Do build deterministic support for skills: source adapters, triage, pinning,
  lock verification, placement, liveness checks, `kit skill test`, profile
  declarations, and machine-readable receipts.
- Personal skill installs stay outside repo config unless a repo deliberately
  declares a shared profile. A public repo must not commit one user's local skill
  inventory as team policy.
- If a proposed kit feature needs a model judgement to decide pass/fail, keep it
  in a skill or expose a deterministic primitive that the skill can call.
