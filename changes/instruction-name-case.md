### Fixed

- **`kit triage instructions` reads instruction files whatever the case of their name.** It
  matched `AGENTS.md`, `CLAUDE.md` and the other names exactly, so `agents.md` was never read.
  macOS and Windows open `agents.md` when an agent asks for `AGENTS.md`. Packages now ship such
  guides for coding agents too: `xstate@6.0.0-beta.3` has `docs/agents.md`, and its README tells
  agents to start there. A planted line in that file was not reported; it is now. Found in
  kit-research `xstate-v6-beta-vs-kit`.
