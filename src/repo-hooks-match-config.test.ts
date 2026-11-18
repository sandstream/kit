import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { missingHookCommands } from "./hooks.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `kit check` and `kit review` read a hook's content and look for each command that .kit.toml
// lists, as the literal text. A hook that runs the command through another spelling (an absolute
// path, a wrapper) does the same work but reads as "missing 1 configured command(s)". Kit's own
// tracked hooks must satisfy kit's own check.
describe("kit's tracked git hooks name every command .kit.toml configures", () => {
  it("each .githooks/<hook> contains the commands listed for that hook", async () => {
    const config = await loadConfig(join(root, ".kit.toml"));
    const problems: string[] = [];
    for (const [hook, commands] of Object.entries(config.hooks ?? {})) {
      const file = join(root, ".githooks", hook);
      if (!existsSync(file)) continue;
      const missing = missingHookCommands(readFileSync(file, "utf8"), commands ?? []);
      if (missing.length > 0) problems.push(`.githooks/${hook} lacks: ${missing.join(", ")}`);
    }
    assert.deepEqual(problems, []);
  });
});
