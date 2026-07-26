# kit MCP Tools Guide

kit ships an MCP server (`kit mcp` / `dist/mcp-server.js`) so shell-less
clients — Claude Desktop, some Cursor modes — can still drive the gates. The
tool-by-tool reference lives in [MCP_TOOLS_REFERENCE.md](MCP_TOOLS_REFERENCE.md);
this guide covers how to wire it up and how the surface is meant to be used.

**The CLI-first rule.** An agent with shell access should run `kit <command>`
directly: the CLI covers all ~68 commands, costs zero standing context, and
`kit <command> --help` self-documents. The server's own `instructions` field
(sent in the MCP `initialize` result) says exactly this, so well-behaved
clients route accordingly. The MCP tools exist for clients that cannot shell
out — they are a compatibility facade, not the product surface.

## Registration

Claude Code:

```bash
claude mcp add kit -- npx -y sandstream-kit mcp
```

Or in `.mcp.json` (any MCP-capable client):

```json
{
  "mcpServers": {
    "kit": { "command": "npx", "args": ["-y", "sandstream-kit", "mcp"] }
  }
}
```

## The canonical loop

```
kit_check   → verify env + security; same verdict as `kit check`
kit_fix     → auto-repair what check found
kit_triage  → REQUIRED before installing anything the install gate has not
              already cleared — the gate blocks untriaged installs, and an
              MCP-run triage satisfies it identically to a CLI-run one
kit_memory  → recall prior cross-session decisions before answering
              project-specific questions
kit_run     → escape hatch: any other kit command
```

## Safety model

- **Read-only mode.** `KIT_READ_ONLY=1` makes every mutating tool refuse with
  an explicit error. `kit_triage` also refuses — it appends a PASS to the
  triage log, and an unrecordable pass could not satisfy the gates anyway
  (fail-closed).
- **Governance floor.** Mutating tools pass revocation, budget, permission,
  and expired-secret checks before executing, and are audited — the same
  floor the CLI's `withGovernance` applies.
- **Effect declarations.** Broker-mediated tools declare what they touch
  (`fsWrites` on `kit_secrets`, extracted `egressTargets` on `kit_run`,
  `infrastructure` on provisioning) so a signed `[scope]`/RoE can mediate
  them. Audit evidence lands in the governed project's `.kit-audit.jsonl`.
- **Memory is search-only.** `kit_memory` never writes: an MCP client cannot
  inject text into the trusted store. Quarantined (injection-flagged) rows are
  excluded from recall.
- **Secrets never round-trip.** `kit_secrets` returns key names and statuses,
  never values.

## Deprecations

`kit_ci`, `kit_install`, `kit_login`, `kit_add`, and `kit_env` are marked
deprecated and leave the MCP surface in kit 6.0 (the stability policy requires
notice before removal). Their descriptions say so and point to the
replacement; `kit_run` remains the escape hatch for all of them. Rationale:
CI runners and setup-time provisioning are shell contexts by definition — a
shell-less MCP client is never the thing running CI or provisioning services.

## Drift guarantees

Three tests keep this surface honest:

- `KIT_MCP_TOOLS` ↔ actually-registered tools ↔ the CLI registry's `mcp`
  flags (CLI = MCP, `mcp-server.test.ts`);
- `x-kit-audience`: a human/harness command is never MCP-exposed, modulo the
  pinned 6.0 deprecations (`opencli.test.ts`);
- this documentation ↔ `KIT_MCP_TOOLS`, in both directions
  (`docs-mcp-sync.test.ts`) — every real tool documented, no fictional tool
  documentable.
