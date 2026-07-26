---
id: ADR-0002
title: Dependency floor — four runtime deps, stdlib otherwise
status: accepted
---

# ADR-0002: Dependency floor

## Decision

kit is a supply-chain gate; its own supply chain is the first thing an auditor
reads. The runtime dependency set stays at the minimum that cannot reasonably
be stdlib (`@modelcontextprotocol/sdk`, `@upstash/redis`, `smol-toml`, `zod`).
Utility libraries are forbidden — Node's stdlib covers them (`node:` builtins,
global `fetch`, `structuredClone`, …).

## Consequences

Adding a runtime dependency is an ADR-level decision, not a convenience call.
The rule below blocks the common utility imports outright; anything else new
must argue its case in a PR that updates this ADR.

```toml kit-enforce
[[forbid_import]]
import = "^(lodash|lodash-es|lodash\\.|underscore|ramda|axios|node-fetch|request|moment|dayjs|bluebird|jquery)"
paths = "src/**"
message = "stdlib only — a new runtime dependency is an ADR-level decision (see ADR-0002)"
```
