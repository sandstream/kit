### Changed

- `kit triage skill <pack>` now judges the hook fragments and scripts a pack ships outside its skill directories by the rules it applies to a Claude Code plugin's hooks and scripts: a `*.json` in Claude Code settings shape or with entries carrying `event` and `handler.command`, and every `.sh`, `.py` or `.js` file, are read and no longer listed as `NOT CHECKED`; the rest still are.
