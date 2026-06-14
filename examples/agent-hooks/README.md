# Agent hooks for kit

Templates that wire kit's security checks into AI coding agents so
users never have to remember "run kit before commit" — the agent
does it.

| Provider | Surface | Files |
|----------|---------|-------|
| Claude Code | PostToolUse hook + MCP | `claude-code/settings.json` |
| Codex CLI | AGENTS.md + MCP | `codex/AGENTS.md` |
| Cursor | `.cursorrules` + MCP | `cursor/.cursorrules`, `cursor/mcp.json` |
| Cline | `.clinerules` + MCP | `cline/.clinerules`, `cline/cline_mcp_settings.json` |

## Install

### Claude Code

Merge `claude-code/settings.json` into `.claude/settings.json` (project)
or `~/.claude/settings.json` (user). The PostToolUse hook fires after
every `Edit`/`Write`/`MultiEdit`, runs `kit check --category security`
in `--json` mode, and exits 2 (block) if any check failed — printing the
list to the agent so it can self-correct.

### Codex

Copy `codex/AGENTS.md` content into your project's `AGENTS.md`. Register
the MCP server:

```bash
codex mcp add kit --command node --args dist/cli.js --args mcp
```

### Cursor

Copy `cursor/.cursorrules` to project root. Drop `cursor/mcp.json`
into `.cursor/mcp.json`.

### Cline

Copy `cline/.clinerules` to project root. Merge
`cline/cline_mcp_settings.json` into your Cline MCP settings.

## Cross-provider fallback: pre-commit

If you want a single hook that catches **any** agent (including ones
without hook support), wire it through git:

```toml
# .kit.toml
[hooks]
pre-commit = ["kit check --category security"]
```

`kit init` installs the matching git hook. Any agent that calls
`git commit` gets gated.

## What gets blocked

`kit check --category security` runs:

- `npm audit` (high+)
- bumblebee supply-chain catalog (deep-profile when in CI)
- pinned-version + lockfile-committed checks
- secrets-in-source heuristics
- service-exposure (Ollama / local APIs / etc. listening on 0.0.0.0)
- Socket, Trivy, license-checker, Semgrep when their CLIs are present

Any `fail` result aborts the hook and surfaces the finding to the agent.
`warn`/`skip` results print but don't block.

## Bypassing

Don't. If a hook is genuinely wrong, fix the check or scope it down
in `.kit.toml` — don't `--no-verify` your way out of it.
