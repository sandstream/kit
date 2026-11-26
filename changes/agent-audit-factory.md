### Fixed

- **`kit agent-audit` reads Factory Droid's `.factory/hooks.json`.** kit writes its own Droid gate
  into that file, and a `SessionStart` hook piping a download into a shell there gave no row, while
  the same hook in `.claude/settings.json` failed (kit-research #225).
- **`kit agent-audit`'s pass row says its hook count is git hook files.** It read "1 agent
  config(s) + 0 hook(s)" beside a `.claude/settings.json` holding a `SessionStart` hook, because
  only `.git/hooks`, `.githooks` and `.husky` files are counted; it now reads "0 git hook file(s)".
  Agent hooks are still checked inside each agent config.
