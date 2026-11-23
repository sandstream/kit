### Added

- `kit profile freeze` records the hooks of the project's `.claude/settings.json`, each as event, matcher and command, with a SHA-256 of the project script it runs. `kit profile check` reports a hook that was added or removed and one whose script changed, the way it reports skills and MCP servers; `--gate` fails on it. A profile frozen before this has no hook list: its hooks are not judged, and the output says to freeze again. `.claude/settings.local.json` and `~/.claude/settings.json` are not in the profile, because they belong to one machine.
