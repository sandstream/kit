### Fixed

- The opt-in GuardDog check verifies native npm and PyPI reports against the selected manifest.
- An incomplete report keeps valid malware findings and blocks the strict security gate.
- Kit runs GuardDog on each check. Legacy clean verdicts cannot establish current coverage.
