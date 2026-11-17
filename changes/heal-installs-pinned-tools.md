### Fixed

- **`kit heal` installs the scanner version the project pinned.** Its install recipe asked for `latest` regardless of `.kit.toml` `[tools]`, so healing a missing `trivy` replaced a declared `0.76.1` with the newest release, outside the pin and the cooling window it was chosen under. It now installs the declared version and falls back to `latest` only when nothing is declared.
