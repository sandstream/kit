### Fixed

- **Codex: kit now says that its install gate does not run until you trust it.** Codex runs a project
  hook only in a trusted project and only after the user trusts that hook (a `trusted_hash` in
  `~/.codex/config.toml`, openai/codex `hooks/src/engine/discovery.rs:953-960`). `kit agent-config`
  prints the steps, and `kit check` warns with `codex install-gate trust` until both hold. kit computes
  the hash as Codex does, checked against Codex's own test fixtures, and never writes the trust.
- **Amazon Q on Windows: the install gate now fires.** The shell tool there is `execute_cmd`, which the
  `execute_bash` matcher never matched. kit adds an `execute_cmd` entry, also to agents it wired before.
- **Cursor and Factory Droid: the install gate now fails closed.** Both allowed the call when the hook
  crashed or timed out. Cursor entries get `failClosed: true` and `gate-bash --format cursor` (an
  explicit `{"permission":"allow"}`, because Cursor counts no output as a failure); Droid entries get
  `onFailure: "block"`. Existing kit entries are migrated in place.
- **Factory Droid: `.factory/hooks.json` is now keyed by event name.** kit wrote a `hooks` wrapper,
  which Droid's standalone hook file does not use, so the gate did not load. Existing entries are
  lifted to the top level.
- **Kiro: the install gate is now a standalone `.kiro/hooks/kit-install-gate.json`.** Kiro IDE 1.0 and
  CLI V3 read that file for every agent, including `.md` agents, which kit skipped. Legacy
  `.kiro/agents/*.json` wiring stays for CLI 2.x; V3 array-form agents are no longer reported as wired
  when nothing was written.
- **`kit agent-audit` now reads Factory Droid's event-keyed `.factory/hooks.json`.** It read hooks only
  under a `hooks` wrapper, so the commands in Droid's documented shape were never audited.

### Added

- **`kit check` warns when Aider skips git hooks.** Aider commits with `--no-verify` unless
  `git-commit-verify: true` is set (Aider `aider/repo.py:278-279`), so kit's git hooks never run on its
  commits. The row is `aider git hooks`; the `CONVENTIONS.md` block kit writes for Aider says the same.

### Security

- **kit adopts an existing gate hook only when its command is exactly one kit writes.** A
  repo-committed agent config can hold a command that only mentions `gate-bash`
  (`curl … | sh; kit gate-bash`). kit no longer copies such a command to a new matcher (Amazon Q,
  Kiro), migrates it (Cursor, Droid, Kiro) or asks the user to trust it (Codex); it adds its own
  entry, leaves the look-alike as it is and names it. The Codex steps show the exact command to
  trust. "Exactly" means one of the strings kit writes on this machine, not a path that looks like
  kit: `/tmp/kit gate-bash` or `./node_modules/x/cli.js gate-bash` are look-alikes. When kit lifts
  its Droid handler out of an old wrapper, a foreign handler in the same group stays where it was.
