### Fixed

- **The install gate now blocks in OpenCode 2.x, Cline, Gemini CLI and Antigravity.** Each agent
  had changed its hook contract, and kit's wiring let an untriaged install through without a
  message. OpenCode 2.x does not load V1 plugins, so the plugin is now one file with
  `export default { id, setup, server }`, which OpenCode 2.x and OpenCode 1.4 or later both load
  (OpenCode 1.0 to 1.3 are not supported). Cline's shell tool is `run_commands` with a list of
  commands, so `kit gate-bash` now reads `commands` and gates each one; a `run_commands` call
  whose commands kit cannot read is blocked. Gemini CLI reads a stdout JSON decision before the
  exit code, so the gate runs with `--format gemini`, and `kit agent-config` now says that Gemini
  CLI runs project hooks only in a folder that was trusted with `/permissions trust`.
  Antigravity's `.agents/hooks.json` is keyed by hook name, so kit now writes a
  `kit-install-gate` entry and moves its gate out of the old `hooks` entry without removing other
  hooks. On a deny, `--format antigravity` now writes the stdout decision and also exits 2.
