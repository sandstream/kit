import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TYPESCRIPT_TOOL_VERSIONS } from "./standards-javascript-report.js";

interface CompilerPackage {
  root: string;
  launcher: boolean;
}

/**
 * The typescript package a resolved `tsc` belongs to. npm links `.bin/tsc` to the package's own
 * entry, so the real path lands inside the package. Package managers that write launcher scripts
 * (pnpm, and aube under mise 2026.11) leave a regular file in `node_modules/.bin` with no link to
 * follow; its package is the sibling `node_modules/typescript`.
 */
function compilerPackage(executable: string): CompilerPackage {
  const dir = dirname(executable);
  if (basename(dir) === ".bin") {
    return { root: realpathSync(join(dirname(dir), "typescript")), launcher: true };
  }
  return { root: dirname(dir), launcher: false };
}

/** Locate the compiler API of a supported typescript installation. kit loads the API, never `tsc`. */
export function locateCompiler(bin: string): { api: string; version: string } {
  const executable = realpathSync(bin);
  const { root, launcher } = compilerPackage(executable);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const entry = join(root, "bin", "tsc");
  if (
    manifest.name !== "typescript" ||
    !TYPESCRIPT_TOOL_VERSIONS.has(manifest.version) ||
    (launcher ? realpathSync(entry) !== entry : executable !== entry)
  ) {
    throw new Error(
      "JavaScript analysis requires a supported canonical TypeScript compiler installation",
    );
  }
  const api = realpathSync(join(root, "lib", "typescript.js"));
  if (api !== join(root, "lib", "typescript.js")) {
    throw new Error("TypeScript compiler API leaves its declared installation");
  }
  return { api, version: manifest.version };
}
