### Fixed

- **kit no longer hands mise `latest` for an `npm:` or `pipx:` tool, and `mise use` no longer writes the global mise config.**
  mise resolves `latest` for an `npm:` tool by running `npm view <pkg> dist-tags --json` with the
  first `npm` on PATH. When that `npm` is mise's own shim, the shim resolves the toolset again and
  runs `npm view` again, without bound: one machine collected 4,425 orphaned `npm view` processes
  in under a minute and needed a reboot. kit wrote such entries itself (`mise use <tool>@latest`
  with no `--path`, which from the home folder writes `~/.config/mise/config.toml`). `latest` in
  `.kit.toml [tools]` now means the newest stable release public for the cooling period: kit
  resolves it to that exact version, triages that version, and refuses the install when it cannot
  resolve one. `mise use` gets `--path <project>/mise.toml`, and kit refuses to run it from the
  home folder. A new `kit check` row, `mise npm: tools at latest` (supply-chain), warns when a
  project or global mise config holds an `npm:` tool at `latest` while `npm` is mise's shim, and
  `kit fix` pins each to its installed version. Test runs now point `MISE_GLOBAL_CONFIG_FILE` at an
  empty path, so a real `mise` that a test reaches cannot read the machine's global config.
