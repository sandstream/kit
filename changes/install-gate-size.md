### Fixed

- `src/install-gate.ts` is back under its frozen size (1,339 lines): the requirements-file wiring added for `pip-sync` and `uv pip sync` pushed it to 1,344 and turned main's file-size gate red. The module now imports the requirements helpers under one name and the helper's signature fits one line; behaviour is unchanged.
