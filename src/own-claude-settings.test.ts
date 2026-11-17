/**
 * kit's own committed `.claude/settings.json` must wire the PreToolUse gates, so a fresh clone or a
 * cloud session of kit runs gated. The commands invoke `kit` from PATH, the last-resort form of
 * `kitSubcommandInvocation`: a committed file cannot hold this machine's absolute wrapper path.
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

function preToolUse(): Group[] {
  const raw = readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8");
  const settings = JSON.parse(raw) as { hooks?: { PreToolUse?: Group[] } };
  return settings.hooks?.PreToolUse ?? [];
}

function commandFor(matcher: string): string | undefined {
  const group = preToolUse().find((g) => g.matcher === matcher);
  return group?.hooks?.find((h) => h.type === "command")?.command;
}

describe("kit's own .claude/settings.json", () => {
  it("wires gate-bash on Bash", () => {
    assert.equal(commandFor("Bash"), "kit gate-bash");
  });

  it("wires gate-env on Write|Edit|NotebookEdit", () => {
    assert.equal(commandFor("Write|Edit|NotebookEdit"), "kit gate-env");
  });

  it("holds no machine-specific path in a gate command", () => {
    for (const hook of preToolUse().flatMap((g) => g.hooks ?? [])) {
      assert.ok(!/[/\\]|\$HOME/.test(hook.command ?? ""), `machine-specific: ${hook.command}`);
    }
  });
});
