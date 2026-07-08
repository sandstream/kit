# The zero-LLM verdict — kit's design contract

> **The contract, in one sentence:** kit's security verdicts — every pass/fail, every
> gate decision, every risk score — are produced by **deterministic code, never by a
> language model.** kit ships with **no LLM SDK** and imports none.

This is not a stylistic preference. It is the load-bearing trust property of a security
tool, and kit enforces it mechanically so it cannot quietly erode.

## Why the verdict path must be LLM-free

The 2024–2026 research frontier converges on one uncomfortable result: **LLM-side
judgments do not hold against an adaptive adversary.**

- **LLM-as-a-Judge is an under-explored attack surface.** The first Systematization of
  Knowledge on the security of LLM-as-a-Judge systems (arXiv:2603.29403, *verified 3-0*
  in kit's own gap analysis) screened 863 works, kept 45, and concludes the security
  risks "remain largely unexplored" — finding that judges can be both **attacked**
  (targets of manipulation) and **weaponized** (instruments of attack).
- **Probabilistic injection defenses collapse under adaptive attack.** A meta-analysis
  and top-venue replications (USENIX Security '26; gap analysis §1.1, *verified 3-0*)
  put adaptive attack success **>85–90%** against state-of-the-art defenses.

The implication is direct: **a security pipeline whose verdict is an LLM has a
compromisable trust anchor.** If the thing that decides "is this safe?" can itself be
prompt-injected, poisoned, or talked out of its answer, the gate is theater. So kit's
verdicts are deterministic — regexes, parsers, hashes, signature checks, capability
rules — and an attacker cannot argue with a hash.

This is the same architectural conclusion reached independently by DeepMind's CaMeL and
the NSA's MCP security guidance (gap analysis §3): the reliable remedy is a
deterministic, out-of-band, fail-closed control at the tool/action boundary — *not*
another model asked to be careful.

## What the contract does and does not cover

- **Covered (must be deterministic):** everything on the verdict path — `kit check`,
  `kit check-security`, `kit standards`, the PreToolUse gates (`gate-bash`, `gate-env`),
  the memory write-gate and verified-forget, slopsquat scoring, MCP tool-poisoning
  triage, injection detection, secret detection, signature/attestation verification.
- **Not in scope:** kit does not forbid *you* from using LLMs in your own workflow. kit
  is the deterministic floor **underneath** the agent — it governs whether an action is
  allowed to touch the system, regardless of which model proposed it.

## How it is enforced (not merely asserted)

A promise in a README is not a control. The contract is held by two mechanisms that run
in CI on every change:

1. **Lint ban** — `eslint.config.js` carries a `no-restricted-imports` rule (tagged
   `ZERO-LLM`) that bans importing any LLM SDK (`openai`, `@anthropic-ai/sdk`,
   `@google/generative-ai`, `langchain`, `llamaindex`, …). `npm run lint` fails the
   build if any `src/` file imports one.
2. **Belt-and-suspenders test** — `src/zero-llm-boundary.test.ts` (run by `npm test` in
   the CI gate) closes the two gaps a lint rule alone can't: it fails if the eslint ban
   is **silently removed** from the config, and it fails if any LLM SDK is added as a
   **declared dependency** of the root or any workspace package (a supply-chain foothold
   that could exist before anyone imports it).

Together these make "the verdict is deterministic" a **checkable, CI-gated invariant** —
protected the same way kit protects its frozen command surface — rather than a claim you
have to take on faith.

## Related

- `docs/THREAT_MODEL.md` — kit's threat model and trust boundaries.
- `docs/LOCAL_FIRST_GATE.md` — the local-first, fail-closed gate model.
- kit-research `docs/research/agent-security-gap-analysis.md` §2.3 — the LLM-as-Judge
  evidence behind this contract (verified pass).
