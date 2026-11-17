### Added

- **`kit triage docker` prints the image's OCI source label** (`org.opencontainers.image.source`,
  and `.revision` when set), read from the registry's manifest and config blob without fetching a
  layer. It warns when an unofficial image has no source label, or when the label names an owner
  other than the image's Docker Hub namespace: the backdoored ARTEX image (FBI FLASH 2026-11-13)
  was clean in source and dirty only in its bytes. The label is the publisher's unsigned claim, so
  a match is printed as a claim, not as proof. `KIT_DOCKER_V2_REGISTRY` sets the registry; with
  only `KIT_DOCKER_REGISTRY` set (a mirror), the label is reported as not checked.
