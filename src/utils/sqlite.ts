/**
 * The one place production code loads `node:sqlite`, on first use rather than at import.
 *
 * On Node 22 loading `node:sqlite` prints "ExperimentalWarning: SQLite is an experimental
 * feature" to stderr. A static `import { DatabaseSync } from "node:sqlite"` anywhere in the
 * CLI's static import graph printed it on every kit call, each PreToolUse gate included, though
 * no gate opens a database (kit-research#233, E1). Production code imports the type only and
 * opens databases here; `src/sqlite-lazy-load.test.ts` fails on any other value import.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const load = createRequire(import.meta.url);

/** `new DatabaseSync(path, options)`, loading `node:sqlite` the first time it is called. */
export function openSqlite(
  path: ConstructorParameters<typeof DatabaseSync>[0],
  options?: ConstructorParameters<typeof DatabaseSync>[1],
): DatabaseSync {
  const sqlite = load("node:sqlite") as typeof import("node:sqlite");
  // An explicit `undefined` options argument is refused ("must be an object"): pass it only if set.
  return options === undefined
    ? new sqlite.DatabaseSync(path)
    : new sqlite.DatabaseSync(path, options);
}
