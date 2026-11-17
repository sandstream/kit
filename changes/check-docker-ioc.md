### Added

- **`kit check` compares local Docker images with published IOCs** (`local docker image IOCs`,
  a host row). It reads `docker image ls --digests` only, and fails when an image's repository
  name or registry digest is one a published analysis names as malicious. The list starts with the
  backdoored ARTEX image `tomicdd/artex` and its index and amd64 manifest digests (FBI FLASH
  2026-11-13; `darkfibr/artex-forensics` `evidence/iocs.csv`), each entry citing its source in
  `src/docker-ioc-data.ts`. Matches are exact, so it is not a scanner. Without the docker CLI or
  its daemon, the row is skipped with a plain line.
