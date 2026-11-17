### Fixed

- **The install gate no longer lets `cd <elsewhere> && npx <name>` through untriaged.** It skips triage for `npx <name>` when `node_modules/.bin/<name>` exists, because npx runs that local binary; it looked for the binary in the hook's directory, not the one the command moves to, where npx fetches the registry package. A command that may change directory (`cd`, `pushd`, `Set-Location`, `--prefix`, `--cwd`, `-C`) no longer gets the local-binary exemption. Claude Code's Code Mode adds a `cd '<dir>' &&` prefix to shell calls.
