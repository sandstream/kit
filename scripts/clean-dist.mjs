// Cross-platform `rm -rf dist` for the build script (#43). Uses node's built-in
// fs.rmSync so it needs no external dep (rimraf isn't a direct dependency) and
// works identically on POSIX + Windows.
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
