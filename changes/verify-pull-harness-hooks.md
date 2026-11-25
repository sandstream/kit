### Fixed

- **`kit security verify-pull` names the Codex, Cursor and Factory Droid hook files a pull adds.**
  A branch adding `.codex/hooks.json`, `.cursor/hooks.json` and `.factory/hooks.json`, each with a
  `SessionStart` hook, printed "No findings" while the same hook in `.claude/settings.json` was
  listed under "file(s) an agent or editor runs or obeys". The path list had drifted from the files
  `kit agent-audit` reads and kit's own agent config writes gates into; it now also names
  `.codex/config.json`, `.agents/hooks.json`, `.augment/settings.json`, Cline's `.clinerules`
  (rules and hooks), and the Claude and OpenCode plugin directories, and labels `.codex/config.toml`
  as able to hold hooks. A test reads both lists out of their sources and fails on a missing path
  (kit-research #225).
