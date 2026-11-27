---
id: ADR-0002
title: Dependency floor — two runtime deps, stdlib otherwise
status: accepted
enforced_by: [src/dependency-floor.test.ts]
---

# ADR-0002: Dependency floor

## Decision

kit is a supply-chain gate; its own supply chain is the first thing an auditor
reads. The runtime dependency set stays at the minimum that cannot reasonably
be stdlib (`smol-toml`, `zod`).
Utility libraries are forbidden — Node's stdlib covers them (`node:` builtins,
global `fetch`, `structuredClone`, …).

## Consequences

Adding a runtime dependency is an ADR-level decision, not a convenience call.
The rule below blocks the common utility imports outright; anything else new
must argue its case in a PR that updates this ADR.

## Amended 2026-11-19: two runtime deps

`@modelcontextprotocol/sdk` moves to `devDependencies`. kit serves MCP over stdio with
`src/mcp-stdio.ts` (JSON-RPC 2.0, one message per line; `initialize`, `ping`, `tools/list`,
`tools/call`), which imports only `zod` and Node. The SDK stays in the tests as the reference:
`src/mcp-stdio.test.ts` and `src/mcp-stdio-kit-tools.test.ts` send the same messages to both servers
and compare every answer. The installed production tree goes from 92 packages to 2. The floor is
now `smol-toml` and `zod`. Plan and evidence: `docs/plans/2026-11-18-few-dependencies.md`.

## Amended 2026-11-18: three runtime deps <!-- kit-self-audit: allow-count -->

`@upstash/redis` is removed. No production code imported it: the Upstash adapter calls
`api.upstash.com` with the global `fetch`, and `service-registry.ts` only holds the package name
as a string to detect in other people's projects. It still shipped, with one package of its own, so
the installed production tree went from 94 to 92 packages. The floor is now `@modelcontextprotocol/sdk`,
`smol-toml` and `zod`.

`src/dependency-floor.test.ts` gained the check that was missing: every declared runtime
dependency must be imported by production code. A manifest entry nothing imports is surface, not a
dependency, and the old floor test could not see it.

## Where the floor is actually enforced — and why not here

**Amended 2026-08-29.** This ADR declared more than its `kit-enforce` block enforced, and
the gap was found the only way such gaps are found: by breaking the rule and watching the
gate stay green. `kit pkg npm:jscpd` added a fifth runtime dependency to `package.json`,
and `kit adr check` reported `✓ 4 enforced ADR(s) — no new violations`.

The block below is a **deny-list of twelve named packages, matched at the import level in
`src/**`**. It cannot see a dependency that is not on the list, and it cannot see one that
has been added to the manifest but not yet imported. The title then said "four runtime deps"; <!-- kit-self-audit: allow-count -->
the rule says "not these twelve".

The floor is **not expressible in the `kit-enforce` grammar**, for two structural reasons:

1. `package.json` is not in the file set the ADR gate walks — `CODE_EXTS` in
   `src/commands/adr.ts` lists source extensions only, so no rule here can ever apply to a
   manifest.
2. `forbid_pattern` and `require_pattern` are matched **line by line**
   (`firstMatchingLine` splits on newlines). An entry in `dependencies` is textually
   identical to one in `devDependencies`, so a line-based regex cannot tell them apart, and
   a multi-line pattern pinning the whole block cannot match at all.

Widening the walk and adding block-aware matching to serve one rule is a larger change than
the rule is worth. So the floor is enforced by **`src/dependency-floor.test.ts`**, which
asserts the exact runtime dependency set and that every version is pinned rather than a
range. It runs in the same CI job as everything else and fails the moment either claim
stops being true.

The `kit-enforce` block stays: it catches the utility-import case earlier and more cheaply,
in review rather than in the suite. It is a first line, not the line.

**A dev tool kit shells out to — a scanner, a linter — is not a runtime dependency.** It is
installed as a tool and must never be added to `dependencies`; that mistake is what exposed
this gap.

```toml kit-enforce
[[forbid_import]]
import = "^(lodash|lodash-es|lodash\\.|underscore|ramda|axios|node-fetch|request|moment|dayjs|bluebird|jquery)"
paths = "src/**"
message = "stdlib only — a new runtime dependency is an ADR-level decision (see ADR-0002)"
```
