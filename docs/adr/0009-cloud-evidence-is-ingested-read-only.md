---
id: ADR-0009
title: cloud evidence is ingested read-only, kit holds no cloud credential
status: accepted
enforced_by: [src/ingest-offline.test.ts, src/commands/ingest.test.ts]
---

# ADR-0009: cloud evidence is ingested read-only

## Decision

kit reads evidence about a cloud account. It never writes to one, and it holds no cloud
credential of its own.

- The customer, or the customer's CI, runs a cloud scanner (for example `prowler` or Scout
  Suite) with its own read-only identity.
- `kit ingest sarif <file>` reads the resulting report and prints normalized findings.
- Configured scanner adapters use the same strict parser to feed the security verdict.
- kit does not start a cloud scanner and does not call a cloud API in this phase.
- kit has no cloud write action, and `kit heal` has no cloud step.

Starting a cloud scanner from kit (layered plan L4b and L4c) is a separate decision. It
changes kit's reach from a repository to an account, so it needs its own ADR or an amendment
of this one, and a role allowlist that the ADR names.

## Rationale

- Ingest gives the evidence without kit launching a large third-party tool that has account
  access. The LiteLLM incident of 2026-10 shows that supply-chain exposure is real.
- `kit ingest` already exists, so this phase adds no new reach and no new dependency (ADR-0002).
- A report that kit did not produce is evidence of what the scanner saw, not proof of the
  account state. The verdict must say so.

## What is not decided here

- Which roles a future cloud delegate may hold. Candidates are `roles/viewer` and
  `roles/cloudasset.viewer`. The owner decides the list before L4b.
- Registry discovery of running images. It needs a cloud read, so it waits for L4b.

## Enforcement

The "no cloud call" rule does not fit the `kit-enforce` grammar without false positives, so
it has no `kit-enforce` block. `src/ingest-offline.test.ts` runs the real `kit ingest sarif`
command with `fetch`, sockets, DNS, `http` and `https` blocked, and it must still succeed. A
control case proves the block works. Adding a `fetch` call to the built ingest code made the
test fail. `src/commands/ingest.test.ts` also covers interactive imports with update suppression removed.
It checks both report formats and blocks registry notices after the command.
Negative controls prove that the network guard stops an attempted call.
These tests cover `kit ingest` only. They do not cover a future cloud delegate.

The owner accepted this ADR on 2026-11-02.
