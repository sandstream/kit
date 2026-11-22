### Changed

- CI runs the Linux test suite in four parallel shards, as the Windows job does. Every test file still runs once on every pull request and push to `main`. `build-and-test` remains the single result: it passes only when the checks job (format, lint, build, gates) and all four shards passed.
