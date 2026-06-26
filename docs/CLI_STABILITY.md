# CLI Stability

kit 2.0 freezes its public command surface and makes that promise _enforced_,
not merely asserted. Every top-level command carries a stability tier, and a
committed golden snapshot of the surface fails CI when it drifts without an
explicit acknowledgement.

This document covers the per-command tiers and the deprecation policy. For the
wider versioning strategy (semver, plugin compatibility, LTS) see
[API_STABILITY_AND_VERSIONING.md](./API_STABILITY_AND_VERSIONING.md).

## Tiers

Each top-level command has a tier in `COMMAND_TIERS` (in `src/cli.ts`), keyed by
the same name as the dispatch table (`COMMANDS`) and the help table
(`COMMAND_HELP`). `command-surface.test.ts` enforces three-way parity: every
command has a tier _and_ a help entry, so the surface can never silently drift.

| Tier           | Promise                                                                                                                              | Breaking change allowed in |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `stable`       | Covered by the 2.x compatibility promise. The command keeps working with the same name and core behavior across the entire 2.x line. | MAJOR only (3.0)           |
| `experimental` | Shipped, but the shape (flags, output, subcommands) may change across MINOR versions. Use with that caveat.                          | MINOR                      |
| `deprecated`   | Slated for removal in a future MAJOR. Still runs, but prints a deprecation warning to stderr on every invocation.                    | removed in next MAJOR      |

### Current tiers

Almost every shipped command is `stable`. The exception is:

- `team` - `experimental`. The RBAC/team-management backend is not wired yet
  (the command currently prints placeholders), so its surface may still change.

The authoritative, machine-readable list lives in
[`contracts/public-surface.json`](../contracts/public-surface.json) under
`commands`.

## Stable command promise

For a `stable` command, across the whole 2.x line kit will not:

- remove or rename the command,
- remove a documented subcommand,
- change exit-code semantics (0 = success, non-zero = failure/refusal), or
- break the documented machine-readable (`--json`) output in an incompatible way.

Additive changes (new flags, new subcommands, new optional `--json` fields) are
allowed in MINOR releases.

## Deprecation policy

A command is deprecated by setting its tier to `deprecated` in `COMMAND_TIERS`.
From that point:

1. The command keeps working for the rest of the current MAJOR line.
2. On every invocation it prints a warning to **stderr** (never stdout, so
   machine-readable output stays clean):

   ```
   warning: 'kit <command>' is deprecated and will be removed in a future major version. See docs/CLI_STABILITY.md.
   ```

   This is wired in `main()` via `emitDeprecationWarning()` and unit-tested in
   `command-surface.test.ts`.

3. It is removed only in the next MAJOR version, with a changelog entry and a
   migration note.

No commands are deprecated at 2.0. The mechanism is in place so that when the
first one is, the warning fires automatically.

## How the freeze is enforced

`scripts/gen-public-surface.mjs` emits a deterministic JSON snapshot of the
public surface (command names + tiers, help keys, config schema version + known
sections, adapter-sdk exports + version, MCP tool names, exit codes) to
`contracts/public-surface.json`. `public-surface.test.ts` regenerates the surface
and diffs it against the committed file.

If you change the surface intentionally:

1. Review the diff the failing test prints.
2. Run `npm run build && node scripts/gen-public-surface.mjs` to regenerate.
3. Commit the updated `contracts/public-surface.json`.
4. If the change removes or renames a `stable` contract, add a **BREAKING** note
   to the changelog/PR (it is only allowed in a MAJOR release).
