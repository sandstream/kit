### Fixed

- **`kit agent-audit` no longer reports kit's own triage skill as a malware-shaped user skill.**
  `kit triage` installs its scanner into `~/.claude/skills/triage`, and the user-surface audit
  then flagged `scripts/plugin_scan.py`, because its detection patterns look like what they
  detect. A file whose bytes match the copy kit ships is now skipped; a copy with any change is
  still flagged.
