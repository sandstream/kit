# Kit modules phase 0 baseline

This baseline supports the [modules and agent adapters plan](plans/2026-11-03-kit-modules-plan.md).
It records existing behavior before the first required security check moves behind an interface.
The plan carries its November 3 baseline. The measurements below describe the phase 0 code.

## Capability map

| Capability                   | Owner                                                | State and current operations                                                                                                                                                | Access and recovery                                                                                                                               |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security checks and verdicts | `src/check*.ts`, broker and governance               | Built for bundled checks. Check creates evidence. Review and audit read it. Rerun a check to refresh its evidence. A separately loaded required-check interface is missing. | Trusted Kit code owns policy and the final verdict. Audit verification preserves an invalid log.                                                  |
| Memory                       | `src/commands/memory.ts`, `src/memory/`              | Built. Index creates and updates local records. Search and recall read them. Forget removes data and records a tombstone.                                                   | The write gate controls mutations. Encrypted backup and restore provide recovery. Restore refuses a live destination.                             |
| Pending Action Ledger        | `src/commands/memory*.ts`, `src/memory/pal*.ts`      | Built. Add creates an item. List and show read current items and revisions. Claim, renew, release and close change state. Forget removes current and historical text.       | Project and device scope control visibility. A restored verification definition needs local approval. An imported claim can require takeover.     |
| Agent integrations           | Agent configuration, hooks and memory import parsers | Partial across harnesses. Install, status, reconcile and removal depend on the harness. A common transcript adapter interface is missing.                                   | Active profile rules govern hooks. Claude and Codex import tests cover supported request and result records.                                      |
| Coverage mappings            | `src/coverage/` and reporting commands               | Built for bundled mappings. Reports derive coverage from source. Settings enable and disable standards. A separate missing-mapping contract is missing.                     | The CLI refuses an unknown or disabled standard. ADR-0003 separates mapping imports from the check path.                                          |
| MCP                          | `src/mcp-server.ts` and command handlers             | Built. The stdio server lists and invokes registered tools. Each handler owns its reads and mutations. Server exit ends the session.                                        | Core governance retains authority. A client can continue after a child failure or invalid tool input.                                             |
| Browser                      | Browser commands, checks and release hooks           | Built for current commands and hooks. Install and remove manage browser gates. Native browser session coverage is partial in this baseline.                                 | The CLI protects credential-bearing connection URLs. Hook checks refuse unsafe paths.                                                             |
| Rig                          | `src/rig/` and its command                           | Built locally. Plan creates inputs. Ingest saves results. Report reads adjudication. A changed prompt gets a new input identity.                                            | Read-only mode refuses updates. Strict ingestion refuses invalid input. External adjudication remains unverified here.                            |
| Local services               | `src/services/`, `src/commands/services.ts`          | Built for the registry and PID lifecycle. Add registers a service. List reads ownership and liveness. Renew changes the lease. Stop and prune remove entries.               | The lease protects another owner's process. Failed stop keeps evidence in the registry. Docker and Supabase coverage is limited to fixtures here. |

## Import map

The baseline inventory scans tracked production TypeScript files under `src/` and package `src/` directories.
It excludes declarations, test files and test support files.
The map records callers, destination files and type-only, static or dynamic literal imports.
The baseline at `2ed06d8d` has 843 production files and 2,911 resolved relative imports.
It records 1,247 non-relative specifiers, four computed dynamic imports and zero unresolved relative literals.
Computed imports require review at their call sites.
Use the owner paths above to relate each import to its responsibility.

## Memory and runtime

The local store uses SQLite schema 18 and an FTS5 index.
It stores sessions, messages, tool requests, file index records and deletion tombstones.
The current Claude and Codex parsers capture supported tool requests and reported outcomes.
Tool result bodies stay outside searchable conversation text.
Unsupported records leave a capture gap. Existing backup and sync policies stay opt-in.

The package declares Node 22.0.0 as its minimum.
Selected macOS and Linux arm64 runs verified FTS5 and memory from Node 22.16.0 upward.
The measured Node 22.13.0 and 22.15.0 builds could load SQLite but lacked FTS5.
This baseline records the gap. The package retains its declared version floor.

## Contract tests

Run the compiled CLI and SDK tests with the project's Node runtime.

```sh
npm run build
node --test dist/cli-module-baseline.test.js dist/run-stdio-mcp.test.js dist/cli-dispatch-contract.test.js dist/cli-run-contract.test.js dist/commands/memory-pal-list.test.js
node dist/cli.js adr check
```

The tests cover JSON and exit codes for empty memory and action lists, optional deployment configuration and required Git ignore protection.
The MCP client connects to the public stdio command.
The tests cover child input and output isolation, exit status and protocol continuity.

Phase 1 starts after phase 0 merges and its required checks pass.
