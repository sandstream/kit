---
id: ADR-0006
title: src/utils is a leaf — it depends on nothing in the repo
status: accepted
---

# ADR-0006: src/utils is a leaf

## Decision

No file under `src/utils/**` imports anything else in this repository. It may use Node
builtins and declared dependencies; it may not reach into `src/` — not a sibling
subsystem, not the root, not the command layer.

## Rationale

This was not decided in a meeting. It was **derived from the code by `kit adr derive`**
and then confirmed by measurement, which is the point: a constraint the whole repo has
obeyed is a decision whether or not anyone wrote it down.

Measured on the import graph at the time of writing:

| direction | edges |
|---|---|
| `commands` → `utils` | 113 distinct file pairs |
| `(root)` → `utils` | 86 |
| `utils` → **anything in `src/`** | **0** |

`kit adr derive` proposed three separate candidates from that asymmetry (`utils →
commands` at 113, `utils → adapters` at 8, `utils → memory` at 5). They are one rule:
`utils` imports **nothing**. Enforcing the general form is simpler than enforcing three
special cases, and it covers a subsystem that does not exist yet.

Why it matters beyond tidiness: `utils` is the most fanned-in directory in the repo.
Anything it imports is imported, transitively, by almost everything. A single upward
import from `utils` into a subsystem creates a cycle through the majority of the tree and
makes the affected modules untestable in isolation. Keeping the bottom of the stack at
the bottom is what makes the layers above it movable.

## Consequences

- A helper in `utils` that needs a subsystem's type or function does not belong in
  `utils`. Move it to the subsystem, or push the dependency the other way (pass the value
  in rather than reaching for it).
- The rule is stated as "no parent-relative import", which is broader than "no sibling
  subsystem". That is deliberate: `../` from `src/utils/**` can only ever leave `utils`,
  so the broad form has no false positives and needs no maintenance when a directory is
  added.
- Superseding this is an ADR-level act. If `utils` genuinely needs to depend on something,
  amend or supersede this file in the same PR — the gate will otherwise refuse the code
  and cite this ADR.

## Scope of the evidence, stated honestly

This records that the repository behaves as if the decision were made, and that we have
now made it. It is a snapshot of the import graph, not a reconstruction of anyone's
intent — see `kit adr derive`'s own limits (TS/JS + Python relative imports, one source
root, top-level buckets).

Two related candidates were deliberately **not** accepted:

- **"No subsystem imports the command layer"** — true of all 16 subsystems, not just the
  six above the evidence floor, but the general form (`paths = "src/*/**"`) fires on
  `src/commands/adr-derive.test.ts`, where a test fixture *string* containing
  `import "../commands/x.js"` is read as a real import by the text-level extractor. The
  glob grammar has no negation, so "every subsystem except `src/commands/**`" cannot be
  expressed today. Left underived rather than encoded wrong.
- **`profile` does not import `exec-broker`** (support 8) — a lone pair with no wider
  pattern behind it. Insufficient evidence that it is a decision rather than an ordering
  accident.

```toml kit-enforce
[[forbid_import]]
import = "^\\.\\./"
paths = "src/utils/**"
message = "src/utils is a leaf (ADR-0006) — it imports nothing from the rest of the repo; move the helper to the subsystem, or pass the value in"
```
