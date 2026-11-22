### Fixed

- **`kit gate-bash` gates `cargo install`, `cargo binstall`, `go install` and `brew install`.** The
  gate covered npm, PyPI and RubyGems and passed every other install with no output: measured,
  `npm i -g @el4cteo/fast-anything` was refused on the 14-day cooling hold while
  `cargo install fast-anything`, the same one-day-old program, exited 0. Each named crate, Go
  package (`pkg@version`, also under `go run`) and Homebrew formula or cask is now triaged first,
  and the command is refused unless every one passes. An install kit cannot reduce to a registry
  name is refused. `cargo install --path`, `go install .` and `go install ./cmd/x` build what is
  on disk and pass. `cargo install --git`, `--registry`, `--index`, a formula given as a file or
  URL, and an environment word that moves the registry (`GOPROXY=`, `CARGO_REGISTRIES_*_INDEX=`,
  `HOMEBREW_BOTTLE_DOMAIN=`) are refused as unverified sources, with a pointer to
  `kit triage repo`. Not covered: a registry moved by a config file or an earlier `export`, and
  commands that fetch dependencies without naming them (`cargo build`, `cargo add`, `go get`,
  `brew upgrade`, `brew bundle`).

### Added

- **`kit triage cargo <crate>[@version]` and `kit triage go <package>[@version]`.** A crates.io
  release and a Go module release get the same cooling period (`[supply_chain]`, default 14 days)
  and OSV check as npm, pip and gem. For a crate kit reads each version's publish time and whether
  it was yanked, the crate's age, downloads and owners. For a Go module it asks the module proxy,
  resolving `@latest` and the module that holds the package as `go` does. What was not read is
  printed as `NOT CHECKED`: a crate's `build.rs` and procedural macros, a module's source, and the
  Go publish time itself, since the proxy gives the tagged commit's date, which its author sets.
  `KIT_CRATES_REGISTRY` and `KIT_GOPROXY` name mirrors; under air-gap no mirror means no query.
- **`kit triage brew` reads a cask.** A cask (`homebrew/cask/<token>`, which is how the gate names
  `brew install --cask <token>`) is scored on its upstream repository as a formula is; before, a
  cask read as a formula with no upstream and never passed.
