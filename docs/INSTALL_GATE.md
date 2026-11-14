# Install gate boundaries

The install gate inspects the pending command before supported agent tools execute it.
It does not prove that arbitrary shell code or installed dependencies are safe.

## Command wrappers

Kit reads wrapper options before the actual command. It consumes separate values, attached values, and short option groups.
It does not interpret the child's arguments as wrapper options.
For example, `env git show -Sneedle` remains a Git command.

Kit refuses `env -S`, `env --split-string`, and `flock -c` command strings.
It also refuses wrapper options whose argument boundaries it cannot determine.
These refusals apply before ecosystem detection, including commands that would otherwise pass through.
Use explicit command arguments without the unsupported option. For example, use `env npm install package` instead of an `env -S` string.

## Source configuration

Kit refuses uninspected source configuration for covered install and package runner commands:

- `pdm -c` or `pdm --config`.
- `uv --config-file` or `uvx --config-file`.
- `pipx --pip-args`.

This includes options before or after the subcommand, with separate or attached values.
Options after the runner's child command or `--` belong to the child.
Kit refuses source options when unknown flags leave that boundary uncertain.
For example, `uv run -- python app.py --config-file=settings.toml` does not select a package source through that option.

A previous package triage does not verify a source selected by an unread configuration file.
Remove the source configuration to use the default registry. Kit cannot verify installs with these options.

## Limits

This command inspection does not replace dependency checks after a Git update.
Local code, implicit project configuration, lockfile contents, and arbitrary shell programs need separate checks.
An allowed command means that this gate found no blocking condition within its inspected scope.
