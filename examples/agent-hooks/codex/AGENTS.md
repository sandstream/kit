# Codex CLI — kit integration

Codex doesn't have a `PostToolUse` hook system. Three options:

## 1. Project AGENTS.md (recommended)

Codex reads `AGENTS.md` from project root. Add a block instructing the
agent to run `kit check` after any edit batch:

```markdown
## Security gate

After any sequence of file edits, run:

    kit check --category security

If it reports `fail`, halt and surface findings before continuing.
Available via the `kit` MCP server registered in `~/.codex/mcp.json`.
```

## 2. Pre-commit (catches all providers — Claude, Codex, Cursor, Cline, ...)

`.kit.toml`:

```toml
[hooks]
pre-commit = ["kit check --category security"]
```

Any agent that calls `git commit` triggers the check.

## 3. MCP

Codex 0.36+ supports MCP. Register kit:

```bash
codex mcp add kit --command node --args dist/cli.js --args mcp
```

Then the agent can call `kit_check`, `kit_fix`, etc. by tool name
without the user typing slash commands.
