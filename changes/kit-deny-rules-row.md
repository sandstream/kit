### Added

- **`kit check` has a `deny rule liveness` row: it fails when one of the twelve Claude Code deny rules `kit agent-config` wrote is missing from `.claude/settings.json`.** Deleting five of them (the `~/.ssh` read rule and the four force-push forms) and adding three allow rules to `.claude/settings.local.json` used to change no `kit check` row, because `enforcement gate liveness` checks the hooks only. The row names each missing rule and the repair (`kit agent-config`, which appends the missing rules and keeps the rest). An allow rule in `.claude/settings.local.json` that matches one of kit's deny rules is named too: in the failure when its deny rule is gone, and in the passing detail while the deny rule still wins. The row applies where `kit agent-config` wrote the rules (a new marker, `.claude/.kit-deny-rules-installed`, or any kit deny rule in the file) and skips elsewhere, so a fresh clone, CI, or gates from `kit setup` alone are unaffected. Found by kit-research#239.

### Fixed

- **The README's 7.5.0 entry no longer says `kit agent-config --user` writes deny rules and the sandbox.** It writes the gate hooks only; the deny rules and the sandbox go to the project `.claude/settings.json`.
