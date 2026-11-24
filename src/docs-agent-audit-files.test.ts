/**
 * docs/FEATURES.md ↔ the agent config files `kit agent-audit` reads.
 *
 * The per-agent support matrix said Gemini CLI had no config audit and named only Cursor's
 * `.cursor/mcp.json` after `kit agent-audit` had started reading `.gemini/settings.json` and
 * `.cursor/hooks.json`: the list in src/agent-audit.ts grew and the table did not. The list is
 * read from the source as text, because src/agent-audit.ts is a protected path and exporting
 * the constant for a documentation test is not worth an owner review.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The string entries of `const CONFIG_FILES = [ … ];` in src/agent-audit.ts. */
function auditedConfigFiles(): string[] {
  const source = readFileSync(resolve(root, "src", "agent-audit.ts"), "utf8");
  const block = /const CONFIG_FILES = \[([^\]]*)\]/.exec(source);
  assert.ok(block, "src/agent-audit.ts declares CONFIG_FILES as an array literal");
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("docs/FEATURES.md names every agent config file kit agent-audit reads", () => {
  it("finds a plausible list in the source", () => {
    const files = auditedConfigFiles();
    assert.ok(files.length >= 10, `found ${files.length}`);
    assert.ok(files.includes(".claude/settings.json"));
  });

  it("names each file in backticks", () => {
    const features = readFileSync(resolve(root, "docs", "FEATURES.md"), "utf8");
    const missing = auditedConfigFiles().filter((file) => !features.includes(`\`${file}\``));
    assert.deepEqual(missing, [], "name these in docs/FEATURES.md (footnote 3 of the agent table)");
  });
});
