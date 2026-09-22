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

**What no layer covers today**, written down rather than discovered later:

1. **Gateway / provider packages.** `ai` (Vercel AI SDK) is banned, but a provider package for it
   — `@openrouter/ai-sdk-provider`, `@ai-sdk/*` — is not. A gateway reaches every banned vendor
   without matching any vendor name, because these lists enumerate *vendors* and a gateway is not
   one.
2. **Local inference runtimes.** `node-llama-cpp`, `onnxruntime-node`, `@huggingface/transformers`
   and similar are not banned anywhere. Whether they *should* be is a real question this ADR does
   not currently answer: "zero-LLM" bundles four distinct prohibitions — a network call to a
   vendor, non-determinism in a verdict, free-text generation parsed into a decision, and a model
   supplying the judgement — and a local, deterministic, non-generative classifier violates only
   the last. **ADR-0007 already rules on that one** ("the deterministic adjudication … never by a
   model"), so the split is: ADR-0001 keeps model calls out of the gate, ADR-0007 keeps model
   output out of a verdict.

Neither gap is an accident to be fixed by lengthening a list — a deny-list of vendors cannot
express "no model calls", because the set of paths to a model is not the set of vendors. They are
recorded here so the claim this ADR makes is not read as wider than what runs.
