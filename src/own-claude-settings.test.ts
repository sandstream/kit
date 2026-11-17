/**
 * kit's own committed `.claude/settings.json` wires the gates at session start, not as committed
 * PreToolUse entries: a committed gate command cannot be both portable and live (kit's liveness rule
 * rejects a bare `kit`; the forms it accepts name one machine's paths). `kit hooks gates` writes the
 * gates in the resolved form on the machine the session runs on (src/session-gates.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Group {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function settings(): { hooks?: Record<string, Group[]> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8"));
}

describe("kit's own .claude/settings.json", () => {
  it("wires the gates at session start with `kit hooks gates`", () => {
    const commands = (settings().hooks?.SessionStart ?? []).flatMap((g) =>
      (g.hooks ?? []).map((h) => h.command),
    );
    assert.ok(commands.includes("kit hooks gates"), commands.join("; "));
    assert.ok(commands.includes("kit hooks context"), commands.join("; "));
  });

  it("commits no PreToolUse gate, which liveness would reject as a bare `kit`", () => {
    assert.deepEqual(settings().hooks?.PreToolUse ?? [], []);
  });
});
