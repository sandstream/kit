# Platform support

kit targets POSIX environments. The runtime is careful about cross-platform
APIs (it uses `execFile` with argument arrays, `os.homedir()`, and
platform-routed commands), but a handful of operational dependencies at the
edges assume a POSIX shell and Unix tooling.

| Platform                              | Status                            | Notes                                                                                                                                                  |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **macOS** (Apple Silicon + Intel)     | ✅ Supported                      | Full feature set. FileVault detected via `fdesetup`.                                                                                                   |
| **Linux** (x86_64 + arm64)            | ✅ Supported                      | Full feature set. LUKS detected via `lsblk`.                                                                                                           |
| **Windows via WSL2**                  | ✅ Supported (recommended)        | Run kit inside your WSL2 distro. Treat it as Linux.                                                                                                    |
| **Windows via Git Bash / MSYS2**      | ✅ Supported                      | Provides the POSIX shell + tools kit relies on.                                                                                                        |
| **Native Windows** (PowerShell / cmd) | ✅ Supported (build + test green) | Builds and the full test suite pass on `windows-latest` CI. A few features degrade gracefully — see [Residual gaps](#residual-gaps-on-native-windows). |

## Running on Windows

Install [WSL2](https://learn.microsoft.com/windows/wsl/install) and run kit
from inside a Linux distro:

```powershell
wsl --install            # one-time, reboots
```

Then, inside the WSL2 shell, follow the normal [Quick start](../README.md#quick-start):

```bash
npm i -g sandstream-kit   # or: npx sandstream-kit setup
cd /path/to/your/repo     # a path inside the WSL filesystem is fastest
kit check
```

> **Tip:** Keep the repo on the Linux filesystem (`~/projects/...`), not under
> `/mnt/c/...`. Working across the Windows↔WSL boundary is slow and can confuse
> git hooks and file permissions.

Git Bash works too for the core commands, but WSL2 is the better experience
(real Linux tooling, mise support, sandboxing).

**Or skip the shell entirely:** the signed Docker image runs the same on
Windows (Docker Desktop), macOS, and Linux — see
[Run via Docker](../README.md#run-via-docker):

```powershell
docker run --rm -v "${PWD}:/work" -w /work sandstream/kit:latest check
```

## Docker engine

kit is engine-agnostic. Anywhere it touches Docker it either calls the standard
`docker` CLI (via `execFile`, no shell), queries the Docker Hub **registry HTTP
API** (`kit triage docker:<image>` — never the local daemon), or reads
`Dockerfile`/Compose files on disk. It never opens the daemon socket directly or
hard-codes Docker Desktop paths.

So **any Docker-CLI-compatible engine works** — Docker Desktop, **[OrbStack](https://orbstack.dev)**,
Colima, Rancher Desktop, or Podman with a `docker` shim. The only requirement is
a `docker` on `PATH` (for `kit pkg docker:` / service adapters); registry triage
needs neither a daemon nor a CLI. There is intentionally no engine-specific
detection — pick whichever engine you prefer.

## Native Windows: what was fixed

The original native-Windows blockers have been resolved cross-platform:

1. **Tool resolution.** `src/utils/resolveTool.ts` uses `where` on Windows and
   `which` on POSIX (the `mise which` fast path runs first on both).
2. **Secret-file permissions.** `src/utils/secure-perms.ts` restricts secret
   files/dirs with `icacls` (strip inherited ACLs, grant only the current user)
   on Windows and `chmod 0o600/0o700` on POSIX, so `~/.kit/memory.db`,
   `mcp-tokens.json`, `elevation.key`, and materialized env files are owner-only
   on NTFS too.
3. **Self-healing hook wrapper.** `kit hooks add` / `kit memory install` emit a
   POSIX `~/.kit/bin/kit` wrapper AND a `~/.kit/bin/kit.cmd` companion shim so a
   bare `kit` resolves from cmd/PowerShell as well as from a hook's `sh`.
4. **The build is cross-platform.** `npm run build` shells out only to node
   helpers (`scripts/clean-dist.mjs` for `rm -rf dist`, `scripts/chmod-cli.mjs`
   for the no-op-on-Windows `chmod +x`) plus `tsc` — no POSIX shell required.
5. **Path + line-ending handling.** Containment checks, plugin dynamic imports
   (`pathToFileURL`), and the public-surface golden snapshot are
   separator/line-ending independent; a repo-wide `.gitattributes eol=lf` keeps
   checkouts byte-identical so snapshot tests match on Windows.

What already worked cross-platform: home/config dir resolution (`os.homedir()`,
`%APPDATA%`), git operations (`execFile`, no shell), browser open
(`start`/`open`/`xdg-open` routing), and the BitLocker branch of the
disk-encryption check.

## Residual gaps on native Windows

These are honest, narrow limitations — kit runs, but a few features degrade:

1. **Supply-chain scanner binary.** bumblebee ships linux/darwin (amd64/arm64)
   tarballs only; there is no native-Windows build. A previously cached binary
   is reused and integrity-verified against its sidecar, but a _fresh_ install on
   native Windows reports `unsupported`. Use WSL2/Docker for `kit scan` there.
2. **Git hooks need a POSIX `sh`.** The generated hooks are `#!/bin/sh` using
   `date`/`stat`/`rm`. Git for Windows bundles `sh` (bash) and runs them, so
   hooks work for anyone with Git for Windows installed; a hypothetical
   git-without-sh environment would not execute them. The `kit.cmd` shim only
   covers invoking kit, not the hook body's coreutils.
3. **`mise`-managed tools.** mise's native-Windows tool support is narrower than
   on POSIX; the shims-on-PATH activation helpers target a POSIX shell profile.

For the richest experience on Windows, WSL2 (or the signed Docker image) remains
the recommendation. Native Windows is now a supported, tested target for the
core workflow.
