// Cross-platform `rm -rf dist` for the build script (#43). Uses node's built-in
// fs.rmSync so it needs no external dep (rimraf isn't a direct dependency) and
// works identically on POSIX + Windows.
//
// The workspace packages compile to `packages/<pkg>/dist/`, and those were left standing by
// every build for as long as this script only knew about the root `dist/`. That is where stale
// output accumulates: a file whose source was deleted, or a cloud-sync conflict copy
// (`adapter 2.js`) that tsc never rewrites because nothing generates it any more. It matters
// because `scripts/test.mjs` collects `packages/*/dist/**/*.test.js` — a survivor there is a
// compiled test running old assertions against new code. So the wipe covers the workspaces too.
//
// This runs FIRST in the build chain, before any workspace tsc, precisely because it deletes
// their output. Moving it back after the workspace builds would erase what they just produced.
import { rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

rmSync("dist", { recursive: true, force: true });

if (existsSync("packages")) {
  for (const pkg of readdirSync("packages", { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    rmSync(join("packages", pkg.name, "dist"), { recursive: true, force: true });
  }
}
