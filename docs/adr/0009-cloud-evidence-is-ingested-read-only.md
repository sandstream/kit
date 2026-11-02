---
id: ADR-0009
title: cloud evidence is ingested read-only, kit holds no cloud credential
status: proposed
---

# ADR-0009: cloud evidence is ingested read-only

## Decision

kit reads evidence about a cloud account. It never writes to one, and it holds no cloud
credential of its own.

- The customer, or the customer's CI, runs a cloud scanner (for example `prowler` or Scout
  Suite) with its own read-only identity.
- kit reads the resulting SARIF with `kit ingest sarif <file>` and merges it into the verdict.
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
  `roles/cloudasset.viewer`. Peter decides the list before L4b.
- Registry discovery of running images. It needs a cloud read, so it waits for L4b.

## Enforcement

This ADR is documented, not enforced. It has no `kit-enforce` block, because "no cloud call"
does not fit the grammar without false positives. A grep of `src/adapters/ingest.ts` and
`src/external-findings.ts` found no `fetch` or network import, only reference URL strings. No
test asserts that today. A test that `kit ingest` makes no network call is a follow-up, and
the ADR should then name it in `enforced_by`.

Status is `proposed` until Peter accepts it.
