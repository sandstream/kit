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

`pip install -r <file>` (also `pip3`, `python -m pip`, `uv pip install`, and the `--requirement` spellings) is held to the same rule.
A requirements file that git does not track needs a `kit triage pip` receipt from the last 7 days for every requirement it names,
matched by normalised PyPI name (`Example_Pkg` and `example-pkg` are one name). A nested `-r`, an index or find-links option,
an editable, a URL or a `name @ url` reference blocks the install; a local path is skipped. A tracked file, or one that does not
exist, stays allowed. A receipt whose timestamp is missing or does not parse is not fresh.

`pip-sync <file>...`, `python -m piptools sync` and `uv pip sync <file>...` install the files they name the same way and
are held to the same rule, with the same message. `pip-sync` with no file reads `requirements.txt`. An index option,
`--find-links`, `--pip-args`, `--config`, `--config-file`, uv's `--directory` or `-` (stdin) blocks the sync.

The gate does not triage transitive dependencies, and a receipt matches a package by name, not by version.
Receipts are per directory, so triage from the directory you install in.

## Prebuilt binaries and release archives

A download alone is allowed. A download that the same command then extracts and runs, makes executable, builds or puts on PATH
is an install, and the gate blocks it (exit 2) until `kit triage release <url>` has recorded a receipt for that exact URL in
`.kit-triage.jsonl` in the directory the command runs in, within the last 7 days. The message names the URL and the command, for example
`kit triage release https://h.example/releases/v1.2.3/tool-linux-amd64.tar.gz`.

- **Fetches:** `curl -o`/`-O` (also `-J`, `--remote-name`, `--url`), `wget` (with or without `-O`), `gh release download -R <o/r> <tag> -p <asset>`,
  PowerShell `Invoke-WebRequest`/`iwr`/`Invoke-RestMethod`/`curl`/`wget` with `-OutFile`, and `Start-BitsTransfer`. A fetch to stdout piped
  into `tar x`, `gunzip` or similar counts as fetched and extracted.
- **Extractions:** `tar`/`bsdtar` with `x`, `unzip`, `7z x`, `gunzip`/`xz -d`/`bunzip2`/`unzstd`, and `Expand-Archive`. Extraction alone
  is allowed, except into an install location (`-C /usr/local`, `/opt`, any `bin` directory, `~/.local`, `C:\Program Files`, `$env:ProgramFiles`).
- **Steps that make it an install:** `chmod` with an execute bit or `Unblock-File` on a fetched or extracted file; running it (`./tool`,
  `sh x.sh`, `python x.py`, `Start-Process`, `& .\x.exe`, `msiexec /i`); `mv`, `cp`, `ln`, `rsync`, `Move-Item` or `Copy-Item` onto PATH
  (`/usr/local/bin` and other `bin` directories, `~`, `$HOME`, `/home/*`, `/Users/*`, `$env:LOCALAPPDATA`, `%LOCALAPPDATA%`, `C:\Program Files`);
  and `install` anywhere, since it sets the mode. A rename (`mv a.tgz b.tgz`) keeps the file's origin.
- **Source tarballs count.** `./configure`, `make` and `cmake` run build files that came in the download. A build after `cd` into the extracted
  tree, or with `make -C <dir>`, is treated as running the fetched code. A build in your own tree after extracting a dataset next to it is not,
  and neither is `python train.py`: a bare script name only counts once the command has `cd`'d into the extracted tree.
- **Fail-closed:** a chain whose URL or file name the shell expands (`curl -o x $URL`), `gh release download` with a glob or without `-R` and a
  tag, `curl -K`, `wget -i`, or a move to a destination the shell expands is refused as unverifiable. With no directory to read receipts from,
  the chain is refused.
- **Not chains:** `chmod +x ./scripts/build.sh` with no download in the command, `git clone`, and a download whose file is only read
  (`jq . a.json`).

The receipt binds the URL; the digest of the file `kit triage release` checked is recorded beside it, but the gate cannot see the bytes a later
download receives. A download in one tool call and its execution in a later one are separate commands, so the gate does not chain them.
A `releases/latest/download` URL never passes triage: triage the tag's URL. The same reading applies when the command arrives through
the `PowerShell` tool name; in Claude Code the `gate-bash` hook is registered for the `Bash` and `PowerShell` tools. Tested on Linux; the
PowerShell and Windows-path cases are tests that also run on the Windows CI shards. No CI job runs macOS, so macOS is unverified.

## A bin named after another package

A plain `npx <name>` (also `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`) with no local install fetches the
unscoped npm name `<name>`. When `<name>` is a bin of a scoped package, that is usually a different package.
`@metaharness/redblue` ships a bin `redblue`, and `npx redblue` without it installed runs an unrelated 2017 package.

- `kit triage npm <pkg>` asks the registry about every bin of `<pkg>` whose name is not `<pkg>` itself.
  It reports `other` (another package owns the name, with its version, maintainers and creation date) or
  `unclaimed` (the name is free, so anyone can register it) as a warning. A bin named after the package itself is `same`.
- Both findings are written to `.kit-triage.jsonl` as `npm-bin` records, whatever the verdict. They are not pass receipts.
- The gate refuses the runner when a record names `<name>`, and says which scoped package to install or to run with `npx -p @scope/pkg <name>`.
- A local `node_modules/.bin/<name>` still allows it, as before, unless the command may change directory first.
  A `kit triage npm <name>` PASS newer than the record also allows it: that is how you say you mean the unscoped package.
- Without a record the gate triages `<name>` as before. It cannot know a README meant another package until that package has been triaged in this directory.

## Limits

This command inspection does not replace dependency checks after a Git update.
Local code, implicit project configuration, lockfile contents, and arbitrary shell programs need separate checks.
An allowed command means that this gate found no blocking condition within its inspected scope.
