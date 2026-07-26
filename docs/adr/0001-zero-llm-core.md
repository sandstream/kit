---
id: ADR-0001
title: Zero-LLM core — kit never calls a model
status: accepted
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
