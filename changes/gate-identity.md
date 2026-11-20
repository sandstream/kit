### Fixed

- `kit check`: `enforcement evidence` now resolves each wired `gate-bash` and `gate-env` command to the kit entrypoint it would start, by reading files only, and fails when a gate is not kit. A settings entry pointing at any executable that exits 0 passed the row before. A gate that runs another kit version warns.
