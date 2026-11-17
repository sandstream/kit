---
id: ADR-0010
title: A gate may ask a person, only through the agent harness, and an unanswerable ask is a deny
status: proposed
---

# ADR-0010: a gate may ask a person, only through the agent harness

## Decision

kit's agent gates (`gate-bash`, `gate-env`, `gate-egress`) gain a third outcome, `ask`, next to
`allow` and `deny`.

- **The rule is deterministic.** Which commands produce `ask` is decided by code and
  configuration, never by a model (ADR-0001). The same input gives the same outcome.
- **The harness asks; kit does not.** For Claude Code, a PreToolUse hook answers `ask` by
  printing `hookSpecificOutput.permissionDecision: "ask"` with a reason, and the harness puts
  the question to the person. The agent cannot answer it as itself. kit runs no approval server
  and holds no session process (ADR-0008, "Kit approvals").
- **Ask never falls through to allow.** Where the harness has no channel that reaches a person,
  `ask` is returned as `deny`, with the same reason and the line "no person can be asked here".
  This applies to a harness without an ask channel, a headless run, a cloud agent, and the exec
  broker. The same applies when kit cannot tell whether a channel exists.
- **Tighten-only.** A project's `.kit.toml` may move a command class from `allow` to `ask`, or
  from `ask` to `deny`. It may not move one from `deny` to `ask`. The agent may not change either.
- **Every ask is recorded.** An `ask` writes an audit row with the command's hash and the
  outcome the harness reports, where it reports one. An ask that nobody answers then still shows
  up in `kit usage`.
- **What asks is a later, separate change.** This ADR decides the mechanism. Today's refusals
  (installs not triaged, hook bypass, the irreversible class from `sandstream/kit#887`) stay
  `deny`. Moving any class to `ask` is its own pull request, which names the class and the
  measurement behind it.

## Rationale

- **The research found the gap.** kit's gates and the exec broker are binary. The broker's
  `BrokerDecision` holds only `ok` and `reason`. When policy says no, the agent decides alone
  what happens next, including whether a person ever hears of it. The escalation note found
  that agents in two incident reports never built a route upward where none existed.
- **Others already ship this state.** Craft Anything has allow/ask/refuse per kind of action,
  and harnesses expose it:
  - Claude Code: `permissionDecision: "ask"` and `--permission-prompt-tool`;
  - Copilot CLI: `permissionDecision: "ask"`, which becomes `deny` in its cloud agent;
  - Antigravity: `decision: "ask"`.
- **A harness channel binds the question to the exact tool input.** Neither the agent's terminal
  nor a pseudo-terminal can answer it. kit's TTY prompt (`sandstream/kit#818`) cannot give that
  guarantee.
- **Ask-as-deny keeps the fail-closed property.** It is what Copilot's cloud agent does, and it
  means adding `ask` can never widen what an agent may do.

## Consequences

- The gate's decision type grows from two outcomes to three. Every caller that maps a decision
  to an exit code must handle `ask`. Tests must show that `ask` becomes exit 2 wherever the hook
  protocol has no ask field.
- Before any class moves to `ask`, the behaviour of `permissionDecision: "ask"` must be measured
  for each harness and mode kit supports:
  - interactive Claude Code;
  - headless `claude -p`;
  - Claude Code on the web;
  - Codex.

  Until a mode is measured, it is treated as having no ask channel, so `ask` is `deny` there.
- The escalation exposure stays named. `kit sentinel` still relies on the agent to deliver its
  `human` findings. This ADR does not change that.
- **Enforcement.** This ADR has no `kit-enforce` block, because the three-outcome rule is not a
  path or import rule. When it is accepted and implemented, its frontmatter must name the tests
  that hold it in `enforced_by:`, at least:
  - ask is deny without a channel;
  - project config cannot loosen deny to ask.

## Sources

- kit-research: `escalation-is-the-missing-primitive.md` and `craft-anything-vs-kit.md`,
  which carries the harness table;
- the owner's decision of 2026-11-17 to write this ADR;
- kit: `src/exec-broker/decisions.ts` and `src/approval.ts`.
