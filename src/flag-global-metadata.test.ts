import assert from "node:assert/strict";
import { it } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GLOBAL_FLAGS } from "./utils/flags.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it("stores global flags once instead of repeating them for each command", async () => {
  const mod = (await import(
    pathToFileURL(join(REPO_ROOT, "scripts", "derive-command-flags.mjs")).href
  )) as { deriveFlagSurface: () => { surface: Record<string, string[]> } };
  const duplicates = Object.entries(mod.deriveFlagSurface().surface).flatMap(([verb, flags]) =>
    flags
      .filter((flag) => (GLOBAL_FLAGS as readonly string[]).includes(flag))
      .map((flag) => `${verb} ${flag}`),
  );
  assert.deepEqual(
    duplicates,
    [],
    "dispatch and OpenCLI already add global flags for every command",
  );
});
