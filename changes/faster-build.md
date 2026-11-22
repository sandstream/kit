### Changed

- `npm run build` runs one script, `scripts/build.mjs`, instead of sixteen chained `npm run` calls. It compiles `adapter-sdk` and `kit-plugin-supabase` first, then the root and the other packages at the same time. Measured on 4 cores: 39 s before, 28 s after. A full build still starts from an empty `dist/`.
- `npm run build:dev` is a new incremental build for development: it recompiles what changed and removes compiled files whose source is gone. Measured: 8 s after a one-file change. CI and release builds stay full.
