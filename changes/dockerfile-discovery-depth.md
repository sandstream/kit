### Fixed

- **`kit check` no longer reports unfinished apk floors in repos without a deep Dockerfile.** The
  Dockerfile walk stopped at depth 3, so an ordinary nested source tree (`crates/x/src/bin`,
  `src-tauri/icons/...`) was reported as an incomplete inventory and blocked the check. The walk now
  goes 16 levels deep, as the browser-script walk does; the 5,000-entry cap still bounds it.
