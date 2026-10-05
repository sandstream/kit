import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** Verbs docs/COMMANDS.md documents as `kit <group> <verb>` inside backticks. */
function documentedVerbs(group: string): string[] {
  const text = readFileSync(join(root, "docs", "COMMANDS.md"), "utf8");
  const found = new Set<string>();
  for (const m of text.matchAll(new RegExp(`\`kit ${group} ([a-z][a-z-]*)`, "g"))) {
    found.add(m[1]);
  }
  return [...found];
}

describe("docs/COMMANDS.md only documents verbs the command handles", () => {
  it("kit hooks", () => {
    const src = readFileSync(join(root, "src", "commands", "hooks.ts"), "utf8");
    const handled = new Set([...src.matchAll(/subcommand === "([a-z-]+)"/g)].map((m) => m[1]));
    const phantom = documentedVerbs("hooks").filter((v) => !handled.has(v));
    assert.deepEqual(phantom, [], `documented but not handled: ${phantom.join(", ")}`);
  });

  it("kit policy hints never name a trust sub-verb", () => {
    for (const file of ["src/commands/policy.ts", "src/profile/portable.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      assert.doesNotMatch(src, /kit policy trust add/, `${file} names a verb that does not exist`);
    }
  });
});

describe("monkey-test env switches are documented", () => {
  it("SKIP_SEED appears in docs/MONKEY_TEST.md", () => {
    const runner = readFileSync(join(root, "src", "monkey-test-runner.ts"), "utf8");
    assert.match(runner, /process\.env\.SKIP_SEED/);
    const doc = readFileSync(join(root, "docs", "MONKEY_TEST.md"), "utf8");
    assert.match(doc, /SKIP_SEED=1/);
  });
});
