### Added

- **Incoming Node runs can load locked npm packages from approved archives.** Kit builds a read-only runtime tree from the captured project and retained archive bytes. The launch gate checks its files and records the input digest. Package installation scripts are never started during materialization.
