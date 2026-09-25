---
id: ADR-0001
title: Zero-LLM core — kit never calls a model
status: accepted
enforced_by: [src/zero-llm-boundary.test.ts, eslint.config.js]
---

# ADR-0001: Zero-LLM core

## Decision

kit's core is deterministic: no code path in `src/` may import an LLM SDK.
"Green = honest" only works when the verdict is reproducible — a model call in
the gate loop would make every result probabilistic, add an egress dependency
to the trust boundary, and put a prompt-injection surface inside the security
tool itself.

## Consequences

Anything model-shaped lives OUTSIDE kit (the agent calls kit, never the
reverse). The zero-LLM boundary test (`zero-llm-boundary.test.ts`) enforces
this at the dependency level; the rule below enforces it at the import level,
so an attempt is caught in review before a dependency is even added.

```toml kit-enforce
[[forbid_import]]
import = "^(openai|@anthropic-ai/|@google/generative|@aws-sdk/client-bedrock|langchain|@langchain/|ollama|cohere-ai|@mistralai/)"
paths = "src/**"
message = "kit's core is zero-LLM by contract (docs/ZERO_LLM_CONTRACT.md) — model calls live in the agent, never in the gate"
```

## Three layers, and what none of them covers

The rule above is the **fast path**, not the boundary. Measured, the invariant is held by three
independent mechanisms, and the `kit-enforce` block is the narrowest of them:

| layer | what it checks | runs in |
|---|---|---|
| the `kit-enforce` rule above | 9 vendor prefixes, imports under `src/**` | `kit review` |
| `eslint.config.js` `no-restricted-imports` | 17 patterns incl. `groq-sdk`, `@google/genai`, `@google-cloud/vertexai`, `ai` | `npm run lint` |
| `src/zero-llm-boundary.test.ts` | 10 SDKs across `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, in the root **and every workspace package** — plus it fails if the eslint rule is deleted | `npm test` |

Do not read the `kit-enforce` list as the contract: it is shorter than the other two and drifts
first. `groq-sdk` and `@google/genai` are absent from it and present in both the others.

**What no layer above covers**, written down rather than discovered later:

1. **Gateways, and it is worse than a missing package name.** `ai` (Vercel AI SDK) is banned, but a
   provider package for it — `@openrouter/ai-sdk-provider`, `@ai-sdk/*` — is not. And a hosted
   gateway does not need a package at all: Convex's AI Gateway documents *"You can also call the
   HTTP API directly with `fetch`"*, which reaches OpenAI, Anthropic, Google, xAI and the rest with
   **zero imports and zero dependencies**. `fetch` is a global, so **no import- or
   dependency-scanning rule can see it** — there is nothing there to see.

   **The answer is Pillar 3, not a longer list.** `checkEgress` in `src/exec-broker/decisions.ts`
   is an **allow-list on hosts**: an unknown host is denied by construction, so a gateway nobody
   has heard of yet is denied too. That makes the broker a fourth layer of this invariant and the
   only one that covers the `fetch` case.

   *A deny-list enumerates what you know; an allow-list denies what you don't.* The three layers
   above are deny-lists and will always have this hole; the broker does not.

   **The caveat that keeps this honest:** the broker is graduated, not on. `enforce-readiness`
   reports `ready | would-block | untested`, and no observe data means `untested` — never a green
   "ready". So this layer covers the case *when a repo has earned enforce*, and on a machine that
   has never run observe the coverage is architectural rather than active.
2. **Local inference runtimes.** `node-llama-cpp`, `onnxruntime-node`, `@huggingface/transformers`
   and similar are not banned anywhere. Whether they *should* be is a real question this ADR does
   not currently answer: "zero-LLM" bundles four distinct prohibitions — a network call to a
   vendor, non-determinism in a verdict, free-text generation parsed into a decision, and a model
   supplying the judgement — and a local, deterministic, non-generative classifier violates only
   the last. **ADR-0007 already rules on that one** ("the deterministic adjudication … never by a
   model"), so the split is: ADR-0001 keeps model calls out of the gate, ADR-0007 keeps model
   output out of a verdict.

Neither gap is an accident to be fixed by lengthening a list: a deny-list of vendors cannot express
"no model calls", because the set of paths to a model is not the set of vendors. Gap 1 has an answer
one pillar over; gap 2 is an open question, not an oversight. Both are recorded here so the claim
this ADR makes is not read as wider than what runs.
