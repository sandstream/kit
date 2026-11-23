### Fixed

- **Grype directory scans use the exact project path and verify package coverage.** Kit reads the package inventory from the same Grype run. A required Grype scan fails when no package was scanned or the inventory does not establish coverage. Readable findings remain available when coverage is incomplete.
