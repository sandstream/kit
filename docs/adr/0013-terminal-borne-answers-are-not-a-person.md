---
id: ADR-0013
title: An answer that arrives through a terminal or the agent's stream is not a person's answer
status: proposed
---

# ADR-0013: a terminal-borne answer is not a person's answer

## Decision

A **terminal-borne answer** is an answer to a gate or approval question that reaches kit or the
harness as input on a terminal, a pseudo-terminal or the agent's own input or output stream. Any
process that can write to that terminal or stream could have typed it:

- the agent itself;
- another agent;
- a terminal multiplexer (`tmux send-keys`, `screen -X stuff`, `herdr pane send-keys`);
- a pseudo-terminal wrapper (`script`, `expect`);
- a write to the terminal device.

The rules:

- **kit never counts a terminal-borne answer as a person's answer.** It does not count for a gate
  decision, an approval, or an action that leaves the box (ADR-0012). `isTTY` proves that a
  terminal is attached. It does not prove that a person is at it.
- **A person's answer arrives on a channel that no process in the agent's session can write to.**
  Two channels qualify:
  - the harness's ask channel (ADR-0010), but only in a mode where the harness shows the question
    outside any terminal the agent's session can type into. A permission dialog drawn in a
    terminal pane that a multiplexer drives is terminal-borne.
  - a signed approval token whose key needs a physical action, such as a hardware key touch under
    `require_hardware_identity`. A token minted at a terminal with a key stored in a file is
    terminal-borne. A process running as the same user can read the key and sign without kit.
- **No channel means a deny.** This is ADR-0010's rule applied to kit's own prompts. Where neither
  channel exists, a question that needs a person is refused. kit does not ask on the terminal and
  then trust the reply.
- **Typing into another terminal is a gated action.** A shell command that sends keystrokes or
  input into a terminal other than its own answers someone else's prompt. Examples are
  `tmux send-keys`, `screen -X stuff`, `herdr pane send-keys`, `herdr agent prompt`, and a write to
  `/dev/pts/*` or `/dev/tty*`. The default is that a person decides, as in ADR-0012.

## Relationship to ADR-0010

ADR-0010 decides that a gate asks a person only through the harness, and it says that "neither the
agent's terminal nor a pseudo-terminal can answer" a question the harness binds to the tool input.
This ADR keeps that decision and extends it in three ways:

1. It names the class of answer that ADR-0010 rules out, so the rule applies to every prompt, not
   only to the harness channel.
2. It applies the rule to kit's own prompts, which ADR-0010 does not cover: `requestApproval` and
   `kit policy approve`.
3. It adds a measurement to ADR-0010's list. Before a harness mode counts as an ask channel, the
   measurement must show that a keystroke sent into the agent's terminal cannot answer the
   question.

If this ADR and ADR-0010 ever conflict, the stricter rule holds.

## What kit does today

Read in the code, and measured on `main` on 2026-11-28. The measurement ran a short script that
calls the built `requestApproval` for a destructive `deploy` to `prod`, with approval configured:

- **A piped answer is refused.** `requestApproval` (`src/approval.ts`, `promptRefusal`) refuses the
  yes/no prompt unless stdin and stdout are both terminals and kit is not in non-interactive mode.
  Measured: a `yes` piped into the script gives `no terminal is attached — operation denied`.
  `src/approval-tty.test.ts` holds this rule. `kit policy approve` (`src/commands/policy.ts`,
  `personConfirms`) uses the same three signals through `personCanAnswer`
  (`src/approval-tokens.ts`, tested in `src/approval-tokens.test.ts`), and it also asks the person
  to type the operation's name back.
- **A signed approval token is checked before any prompt** (`checkSignedApproval`). With
  `require_hardware_identity`, signing needs a hardware keystore backend.

These hold the weaker rule, that a pipe is not a person. They do not hold this ADR, so this ADR
names no `enforced_by:` file.

## What kit does not do

- **A pseudo-terminal answer is accepted.** Measured: `requestApproval` running in a `tmux` pane,
  answered by another process with `tmux send-keys -t p yes Enter`, printed `RESULT=true`. The same
  happened when it ran under `script` with `yes` written to the wrapper's input. `kit policy approve`
  reads the same signals, so the same hole applies to it. That was not measured separately.
- **`gate-bash` passes keystroke injection.** Measured: `tmux send-keys -t 1 y Enter` exits 0. The
  kit-research note measured `herdr pane send-keys w1:p2 y Enter` and `herdr agent prompt` passing
  too.
- **A harness permission dialog in a terminal pane.** kit has not measured whether a keystroke sent
  into the pane can answer the dialog of Claude Code, Codex or another harness. A field report,
  cited below, describes agents typing into each other's panes until one picked an answer to the
  person's open question.

## Rationale

- **A terminal check proves a terminal.** The kit-research note on out-of-loop approvals named this
  hole. The field report turned it from a possibility into an observed event, with agents in
  `herdr` panes.
- **The TTY check closed the easy path, not the class.** `echo yes |` was the obvious bypass, and
  `src/approval-tty.test.ts` closed it. A pseudo-terminal costs one more command, and orchestrators
  that run agents in panes give the agent a pseudo-terminal by default.
- **Presence needs something the session cannot forge.** A harness surface outside the agent's
  terminal, or a physical key touch, is that thing. kit cannot make a terminal dialog unforgeable,
  so it stops treating one as proof.

## Consequences

- **`requestApproval` loses its terminal fallback as proof.** Once this ADR is accepted, the yes/no
  prompt cannot approve an operation that needs a person. It either becomes a deny with the reason
  "no channel a person alone can answer", or it stays only for a declared human-run mode that no
  agent session can set. The pull request that implements this chooses between the two, with a
  test that fails on `main` first: a `yes` sent through a pseudo-terminal must not approve.
- **`kit policy approve` without a hardware key** either mints a token that says it is
  terminal-borne, which no gate in ADR-0012 accepts, or refuses. The same pull request decides.
- **`gate-bash` gains the injection class** in its own pull request: `tmux send-keys`,
  `screen -X stuff`, `herdr pane send-keys` and `herdr agent prompt`, and redirects to `/dev/pts/*`
  or `/dev/tty*`. Each needs a test that fails on `main`. Reading a pane (`tmux capture-pane`) and
  starting a session stay allowed.
- **ADR-0010's measurement grows by one row per harness mode:** can a keystroke sent into the pane
  answer the ask? Until that row is measured, the mode has no ask channel, and an ask in it is a
  deny.
- **Harness coverage.** The injection class is a `gate-bash` refusal. It reaches the harnesses
  where `gate-bash` is installed: Claude Code, Codex, Gemini CLI, OpenCode, Cline, Antigravity,
  Amazon Q, Kiro, Cursor, Factory Droid and Augment. It does not reach GitHub Copilot, for which
  kit installs no gate, or a harness run without kit's hook.
- **Not decided here:** a process that writes to a terminal device in a way `gate-bash` cannot read
  (a compiled helper, or `ioctl(TIOCSTI)` from a script). A command-text gate does not bound this.
  Only an operating-system boundary between the sessions does.
- **Enforcement.** No `kit-enforce` block fits, because the rules are behavioural. When this ADR is
  accepted and implemented, `enforced_by:` must name tests for at least:
  - a `yes` sent through a pseudo-terminal does not approve `requestApproval`;
  - `kit policy approve` without a hardware key mints no token that an ADR-0012 gate accepts;
  - `gate-bash` refuses `tmux send-keys`, `screen -X stuff` and `herdr pane send-keys`;
  - a harness mode with no measured off-terminal channel turns an ask into a deny.

## Sources

- kit-research `agents-as-engineering-org-vs-kit.md`: agents typed into each other's terminals
  until one answered the person's question;
- kit-research `agent-vm-yolo-herdr-paseo-vs-kit.md`: `herdr` and `tmux send-keys` pass
  `gate-bash`, and its owner item 7;
- kit-research `out-of-loop-durable-agents-vs-kit-approvals.md` and `craft-anything-vs-kit.md`:
  approval off the agent's terminal;
- kit: `src/approval.ts`, `src/approval-tokens.ts`, `src/commands/policy.ts`, and
  `src/approval-tty.test.ts`;
- ADR-0010 and ADR-0012.
