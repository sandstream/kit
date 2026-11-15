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

## Bare installs

A bare `npm install`, `npm ci`, `npm update`, `pnpm install`, `yarn` or `bun install` names no package.
It fetches every dependency that `package.json` declares.

- When git tracks `package.json`, `kit triage check-deps` gates a new dependency at commit. The gate allows the install.
- When git does not track it (a Claude Code skill, an unpacked download, a scratch folder), no commit gates it.
  The gate blocks the install until every direct dependency (`dependencies`, `devDependencies`, `optionalDependencies`)
  has a triage receipt in `.kit-triage.jsonl` from the last 7 days. The message names the missing ones and the command to run,
  for example `cd <dir> && kit triage npm axe-core playwright`.
- A git, URL or GitHub-shorthand dependency has no registry triage and blocks the install. A `file:`, `link:` or `workspace:` dependency is skipped.
  An `npm:` alias is triaged under the real package name.
- The gate follows leading `cd <path> &&` steps and `--prefix <dir>` or `-C <dir>`. A `cd` it cannot resolve statically
  (`$VAR`, `$(...)`, a `cd` that does not lead the command) blocks the install. On Windows write the path with forward slashes: the command tokenizer reads a backslash as an escape, so a backslash path is refused as unverifiable (still blocked, never allowed).

- The gate refuses the install when the folder has its own `.npmrc` (it can name another registry) or when the lockfile
  (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`) resolves a package from outside the default
  registry. A folder that holds `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.pnpmfile.cjs`, `bun.lock` or `bun.lockb` is
  refused too: those steer the install or are not parsed here.
- It follows one directory flag: `--prefix` and `-C` for npm, `--prefix`, `-C` and `--dir` for pnpm, `--cwd` for yarn and bun.
  More than one, an `NPM_CONFIG_*` assignment or `env -C` blocks the install, because npm and this gate could pick different folders.
  A flag of another program, such as `git -C`, is not read as npm's.

A tracked `package.json` stays allowed. That relies on `kit triage check-deps` running at commit, which holds only where kit's hooks are
installed. A freshly cloned repository whose hooks are not installed is therefore not covered. Closing that would block `npm ci` in every
checkout, so it is left as a policy decision for the maintainer.

The gate does not triage transitive dependencies, and a receipt matches a package by name, not by version.
Receipts are per directory, so triage from the directory you install in.

## Limits

This command inspection does not replace dependency checks after a Git update.
Local code, implicit project configuration, lockfile contents, and arbitrary shell programs need separate checks.
An allowed command means that this gate found no blocking condition within its inspected scope.
