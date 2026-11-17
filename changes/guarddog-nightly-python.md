### Fixed

- The nightly GuardDog sweep failed at its install step on four nights in a row (14 to 17 November), so it scanned nothing. The runner moved to Python 3.14, where `pygit2` has no wheel. The job now pins Python 3.12.
