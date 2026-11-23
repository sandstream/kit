### Added

- **Incoming Node runs can load locked npm packages from approved archives.** Kit builds a read-only runtime tree from the captured project and retained archive bytes. The signed launch policy needs one independently verified SHA-256 digest for each compressed npm archive. The launch gate checks the derived files and records the input digest. Kit starts no installation scripts during materialization.
