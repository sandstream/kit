# Kit modules and agent adapters

Status: open

> Work on one phase or named subphase at a time. Each gets a separate pull request.
> Start the next only after the previous one is merged and its checks pass.

## Goal

Keep Kit's security floor trustworthy while making its other capabilities easier
to change and use separately. Treat memory as a module. Treat Claude and Codex
transcript imports as adapters to that module.

A module is a responsibility with a small interface. It does not have to be a
separate package. Keep the current distribution until the interfaces and failure
behavior are tested.

## Current baseline

This plan starts from Kit main at `bd1231f` on 2026-11-03. Recheck the current
branch and open pull requests before each phase.

| Capability                                   | Current state                                                 | Direction                                               |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Security gates, policy, signing and receipts | Core paths                                                    | Keep the trusted decisions and verification in the core |
| Memory and PAL                               | Built into Kit and used directly by other paths               | Introduce a memory interface before any extraction      |
| Claude and Codex transcript imports          | Separate parsers, with shared code and direct database access | Put each source behind a memory-owned import interface  |
| Agent hooks, configuration and status        | Mixed with shared Kit code                                    | Split agent-specific placement from shared checks       |
| Coverage standard mappings                   | Kept out of the check path by ADR-0003                        | Extract the mappings after testing their consumers      |
| MCP                                          | Shared transport with fixed tools                             | Preserve the protocol and tool contracts                |
| Browser, rig and local services              | Built into Kit                                                | Keep current ownership until a separate decision        |
| Local usage counts                           | A separate local prototype, not in this baseline              | Reconcile it separately before claiming it is shipped   |

The current service adapter SDK describes service checks and provisioning.
The plugin loader can skip a missing or failed plugin with a warning. Neither is
a security contract for required gates. Do not treat in-process plugins as a sandbox.

## Rules for every phase

- [ ] Keep existing CLI names, exit codes, JSON fields and MCP tool names unless a
      reviewed change states otherwise. Test the existing interfaces with real commands.
- [ ] Keep the core in charge of policy, required gates, trusted verification,
      signatures and receipts. An absent, failed, timed-out, incompatible or incomplete
      required gate must not produce a passing result.
- [ ] Report an absent optional module as absent or skipped. A required module
      that cannot run is unverified and blocks when policy requires it.
- [ ] Preserve `--read-only`, `KIT_READ_ONLY` and policy-based read-only mode
      in the CLI, MCP, direct calls and child processes. Preserve refusal evidence.
- [ ] Keep the zero-LLM and dependency rules in ADR-0001 and ADR-0002. Do not
      add a runtime dependency without the required ADR decision.
- [ ] Preserve the existing privacy contract and opt-in memory sync. Do not add
      remote usage telemetry. Keep any future local usage store separate from memory
      and audit sync, with no network transport.
- [ ] Run Linux and Windows checks. Exercise path-sensitive changes on macOS.
      State any untested platform and any skipped check in the pull request.
- [ ] Record failing baseline checks as open work. Fix a required failure in a
      separate reviewed change before relying on that check. Do not call a skipped
      or failing check green.
- [ ] Track the current phase or subphase in PAL. Update this plan and its open
      PAL item after each step. Close an item only after its verification is complete.

## Phase 0: map behavior and freeze contracts

- [ ] Map the production imports between security, memory, agent integrations,
      coverage, MCP, browser, rig and services. Record callers and current owners.
- [ ] Record a capability map with built, partial and missing states. Include
      create, read, change, delete, access and recovery paths where they apply.
- [ ] Capture representative CLI, exit-code, JSON and MCP behavior in tests.
      Include memory, PAL, security checks and absent optional components.
- [ ] Use a real MCP stdio client to test `kit_run` input, output and protocol
      isolation. Record any existing failure privately before depending on the test.
- [ ] Record the existing privacy and data formats. Claude import stores transcript
      text and tool input today. Codex import does not currently record tool calls.
- [ ] Check the declared Node floor against real memory behavior, including early
      Node 22 releases. Record existing gaps. Do not silently raise the support floor.
- [ ] Track this plan in PAL. While the file exists only in a worktree, use an
      explicit open item. After the canonical local checkout contains the plan, run
      PAL discovery and verify the automatic item is open. Only then reconcile the
      explicit item. A GitHub merge alone does not update the local checkout.

## Phase 1: establish the security interface

### Phase 1a: first required check

- [ ] Inspect the existing `SecurityCheckResult` and gate interfaces first.
      Freeze one required check's current behavior before changing its interface.
- [ ] Keep the current bundled implementation as the default. Keep policy and
      the final verdict in trusted Kit code. Test that missing or failed required
      behavior cannot produce a passing result.

### Phase 1b: second check and trust rules

- [ ] Prove the interface with a second real check. Do not build a generic
      plugin framework just to create a hypothetical interface.
- [ ] Define how Kit verifies the source and integrity of separately loaded required
      implementations. Bind verification to the bytes that execute, before loading.
      Test changes and link swaps between verification and loading. If Kit cannot
      establish that binding, refuse to run the required implementation.
- [ ] Do not claim process isolation unless an actual isolation mechanism
      enforces it.
- [ ] Test missing, altered, incompatible, crashed, timed-out and incomplete
      implementations. A required check must never become green by being skipped.
- [ ] Verify old signed receipts and reject altered signatures and identities.
      Reject receipts for changed PR head, base head or policy head where applicable.
- [ ] Keep the current bundled implementations as the default. Do not route
      required gates through the fail-soft service plugin loader.

## Phase 2: make memory an internal module

- [ ] Define small memory-owned interfaces for each caller's needs. Cover store
      access, search, PAL, import, deletion, backup and restore. Do not expose raw
      database writes to import adapters.
- [ ] Separate shared project identity and security checks from direct imports
      of memory internals. Preserve memory injection checks and quarantine behavior.
- [ ] Preserve the existing database, records, project identity, deduplication,
      incremental markers, search results, shared memory and PAL revision history.
- [ ] Exercise current opt-in sync in both directions. Test conflicts, claims,
      revisions and tombstones without changing the existing trust or privacy rules.
- [ ] Test an existing database and a copy of real-shaped synthetic data before
      and after the change. Test interrupted migration and recovery without data loss.
- [ ] Test downgrade, or provide a tested restore path, for a database changed
      by the new version. Preserve PAL history and tombstones during recovery.
- [ ] Test tombstones against re-import, including a changed source transcript.
      Test backup and restore through the public memory interface.
- [ ] Preserve the distinction between memory not configured and memory expected
      but unreadable. The latter must not be reported as a successful check.

## Phase 3: extract Claude and Codex import adapters

### Phase 3a: import contract and Claude

- [ ] Define one normalized import contract owned by memory. It must carry source,
      session, timestamps and supported message or tool records.
- [ ] Distinguish an empty source from a missing source, an unsupported capability,
      an unreadable source and a corrupt source. One failed adapter must not hide
      results or failures from the others.
- [ ] Move Claude import behind that contract in its own pull request. Test real
      synthetic transcripts, tool input, incremental re-indexing and duplicate input.
- [ ] Exercise Claude through CLI, MCP and hooks. Preserve the memory-owned
      write gate, read-only mode, quarantine, deletion and recovery.
- [ ] Keep existing capture and redaction defaults. Do not add new raw content
      or change the privacy policy without a separate reviewed decision.

### Phase 3b: Codex

- [ ] Move Codex import behind the same contract in a later pull request. Preserve
      current message behavior and report unsupported tool-call capture as a gap.
- [ ] Run both adapters twice against fixtures. Verify search results, deletion,
      quarantine and recovery through the memory interface.
- [ ] Exercise the same write and read-only gates through CLI, MCP and hooks.
      Import adapters must not bypass the memory-owned write path.

## Phase 4: separate other agent-specific adapters

### Phase 4a: capability map

- [ ] List every supported agent environment and its import, hook, placement
      and liveness support. Mark each capability as built, partial or missing.

### Phase 4b and later: one environment per pull request

- [ ] Move one environment at a time behind the same tested interfaces.
      Keep existing commands and configuration working.
- [ ] Keep hook enforcement and liveness verification in the trusted floor.
      A missing required hook must not be reported as installed.
- [ ] Test absent tools, malformed input, upgrades and removal. Do not claim
      feature parity when an environment cannot supply a capability.

## Phase 5: extract coverage mappings

- [ ] Separate standard mappings from the `check` path, as required by ADR-0003.
      Include the current `coverage`, `analyze`, `self-audit` and `usage` consumers.
- [ ] Keep the check and review paths usable when mappings are absent. Report
      the missing coverage capability instead of a passing result.
- [ ] Test mapped, verified, failing and not-run controls. Do not present a
      mapping as proof of compliance or certification.
- [ ] Test the internal mapping interface with mappings present and absent. Use
      real CLI and JSON output. Defer package installation tests to phase 6.

## Phase 6: decide packaging and remaining boundaries

- [ ] Compare a bundled internal module with optional packages after the
      interfaces and absence behavior are tested. Record the chosen distribution.
- [ ] Decide the placement of MCP transport, browser verification, monkey-test,
      rig, local services, upstream watch, usage and insight. Record dependencies
      on the security floor and the user-facing effect of absence.
- [ ] Keep browser ownership consistent with ADR-0005 and rig ownership
      consistent with ADR-0007. Amend an ADR before changing either decision.
- [ ] Test a clean install and an upgrade from the previous version. Keep
      commands available under the chosen distribution or document a reviewed change.
- [ ] Test installation, upgrade and removal of any separately packaged module.
      Repeat the required and optional module failure tests with real packages.

## Done when

- The security floor still enforces every required gate and verifies its evidence.
- Memory and each supported import adapter have tested interfaces and clear gaps.
- Coverage mappings can be absent without breaking checks or claiming success.
- Existing data and supported CLI/MCP contracts survive the selected packaging.
- PAL and this plan show any remaining or deferred work.

## Out of scope

- Moving every capability into a separate repository.
- Adding a model client or a remote telemetry service.
- Publishing packages or changing security ownership without a separate review.
