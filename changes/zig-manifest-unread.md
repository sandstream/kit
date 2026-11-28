### Fixed

- **`kit check`'s `scan scope` row no longer says "no manifest here" at a root that holds
  `build.zig.zon`.** It now warns that the manifest was found but not read, because kit does not
  cover Zig, and still names any projects below. A Zig-only root used to read as a pass
  ("no project manifests here or below"). `docs/FEATURES.md` now names `zig fetch` and the
  dependencies a `build.zig.zon` pins as not covered. Found in the kit-research note
  `connect-zig-vs-kit`.
