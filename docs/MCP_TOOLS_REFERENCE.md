# MCP Tools Quick Reference

The authoritative list is `KIT_MCP_TOOLS` in `src/mcp-server.ts`, mirrored in
`contracts/public-surface.json` (`mcpTools`) and marked per-command as
`x-kit-mcp` in `contracts/kit.opencli.json`. A drift test
(`docs-mcp-sync.test.ts`) fails the build if this document and that list
disagree — in either direction. (This file previously documented a tool set
that never shipped; the gate exists so that cannot happen again.)

If your agent has shell access, prefer the CLI (`kit <command>`): it covers far
more than these tools, costs zero standing context, and `kit <command> --help`
self-documents. The MCP surface exists for shell-less clients.

## The canonical loop

```
kit_check → kit_fix → kit_triage (before any ungated install) → kit_memory → kit_review (before merging) → kit_run
```

## Tools

Every tool accepts an optional `cwd` (defaults to the server's working
directory). Mutating tools refuse when `KIT_READ_ONLY=1` and pass the
governance floor (revocation, budget, permissions, expired-secret block).

| Tool | Kind | Purpose |
| --- | --- | --- |
| `kit_check` | read | Run all checks — tools, services, secrets, skills, hooks, deploy env, security, tests, locks — and return the same verdict `kit check` computes. |
| `kit_review` | read | Full repo audit in one shot — the check, design, standards, and ADR gates as one structured report (`{ ok, failed, stages }`), from the same core `kit review` renders. `stages: ["standards"]` scopes to named gates (the fast, read-only lint loop — no full security scan), `category` scopes the standards stage, `concise: true` omits pass/skip rows (per-stage counts stay). |
| `kit_fix` | write | Auto-fix what `kit_check` found: install missing tools, generate missing lock files. Returns actions taken. |
| `kit_triage` | write | Security-triage a dependency **before** installing it (`type`: npm/pip/docker/brew/repo/skill + `target`). A PASS is recorded in the triage log the install gates read, so an MCP-run triage satisfies them identically to a CLI-run one. Refuses in read-only mode — an unrecordable pass could not satisfy the gates anyway. |
| `kit_memory` | read | Search cross-session conversation memory plus the repo's curated shared decisions (`query`, `limit?`, `global?`). Search-only by design: writes stay on the CLI/indexer path so an MCP client can never inject text into the trusted store. Quarantined rows excluded. A missing store returns empty — it is never created by a read. |
| `kit_secrets` | write | Generate `.env.local` by resolving secrets defined in `.kit.toml`. Returns written key names — never values. |
| `kit_run` | write | Execute a command with the secret-loaded env — the escape hatch for every kit command without its own tool. Egress-mediated via extracted hosts. |
| `kit_context` | read | Gather project context (stack, services, env status) for the agent. |
| `kit_map` | read | Repo map: import-neighborhood slice around seed paths (`paths`, `depth?`, `budget?`, `co_change?`). |
| `kit_init` | write | Detect the stack and generate `.kit.toml` for a project that has none (`dryRun` to preview). |

## Server instructions

The server's MCP `initialize` result carries an `instructions` field stating
the CLI-first rule and the canonical loop. Clients like Claude Code use it to
route tool search — keep it in sync with this document when tools change.

## Error shape

Tools return `{ content: [{ type: "text", text }], isError? }`. `text` is
JSON for structured results, or an `Error: …` line. Read-only refusals and
governance denials are `isError: true` with the reason in `text`.
