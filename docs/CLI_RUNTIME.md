# CLI runtime behaviour

How every `kit` command exits, what read-only mode refuses, and how `kit run` executes a child command.
The command reference is [COMMANDS.md](COMMANDS.md).

## Exit codes

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | success / all checks passing |
| 1    | one or more checks failed    |
| 2    | usage error                  |

## Notes on read-only mode

Mutating CLI forms are declared in `src/read-only-surface.ts` and refuse when
`KIT_READ_ONLY=1` (also `true`, `yes`, or `on`, case-insensitive). Examples:

- `secrets migrate` / `vault-migrate` / `rotate` / `set-value` / `pull --from`
- `auth elevate` (writes elevation marker)
- `hooks install` / `hooks add` / `setup`
- `fix` (writes .env.template, .gitignore, git hooks)
- `mcp set-token` (writes token store)
- Every plugin write surface — see `THREAT_MODEL.md` for the list

`kit check`, `secrets validate`, `env diff`, `mcp list`, and `audit`
are read-only and work in any mode.

## Child command execution

Use `kit run [--env <name>] [--inject] -- <command> [args...]`.
Kit passes arguments after `--` to the child without interpreting them as Kit flags.
The CLI preserves the child exit code. A missing executable returns 127.

Both CLI `run` and MCP `kit_run` load the requested project's configuration before execution.
An absent `.kit.toml` is allowed. An invalid or unreadable existing file stops execution.
The selected environment overlay applies to configuration, including governance.
Kit validates supported sections in every declared overlay, then validates the effective configuration.
Supported overlay sections are `tools`, `services`, `secrets`, `skills`, and `governance`.
Other overlay sections remain stored but do not apply.
The child receives the parent environment plus values from `.env.local`, when that file exists; their key names are first recorded as a `secrets.read` event ([data flow](DATA_FLOW.md#secret-reads-secretsread)).
Without `--inject`, this command does not fetch vault values or generate environment files.

With `--inject` (MCP `kit_run`: `inject: true`), kit resolves every key `.kit.toml` declares in `[secrets.keys]` and passes the values only in the child's environment, over the inherited one. It neither reads nor writes `.env.local`. The read is recorded as `secrets.read` with `via: "kit run"` before any value is fetched, and the values are redacted from the child's output like every declared value. The child does not start when there is no `[secrets.keys]`, a key is prod-scoped outside the prod env (the rule `kit secrets` applies), the read cannot be recorded, or any key does not resolve. On Windows, names are folded case-insensitively, so an inherited `Path` never sits beside an injected `PATH`. Next.js and Vite take an existing `process.env` value ahead of `.env.local`, so `kit run --inject -- next dev` or `kit run --inject -- vite` needs no file. A tool that only reads the file still needs `kit secrets`.

Enabled governance checks permissions, revocation, budget, and configured secret expiration before execution.
Active resource rules inspect the parsed arguments for explicit URL hosts and scheme-less curl/wget targets.
Display quoting cannot change that inspection.
Target read-only policy also applies through MCP. It does not change the server's process policy.
Branch-based governance uses the target project's branch.
Audit command text masks known environment secrets before encoding the arguments.
They cannot infer every network request, file write, or environment access inside an arbitrary program.
Governance and resource rules record their own audit events when enabled.
A nonzero child exit, timeout, or output limit produces a failed completion event.

The CLI streams redacted child output. MCP captures that output as tool result data and closes child standard input.
Child output cannot become MCP protocol messages.

Time and output limits stop the child process group on POSIX systems.
On Windows, Kit requests process-tree termination through `taskkill`.
Cleanup adds at most one second after a limit. Incomplete cleanup is reported in the result.
A descendant that creates a separate POSIX session can escape group termination.
Windows cannot reliably terminate descendants after their parent has exited.
These limits do not provide an operating-system sandbox.
Parent interrupts stop active command groups before the default signal exit.
Captured text preserves UTF-8 characters split across output chunks.
