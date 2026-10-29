import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cmdEscalate } from "./escalate.js";

async function runWithArgs(args: string[]): Promise<{ ok: boolean; errors: string[] }> {
  const originalArgs = process.argv;
  const originalError = console.error;
  const errors: string[] = [];
  process.argv = [originalArgs[0]!, originalArgs[1]!, ...args];
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    return { ok: await cmdEscalate(), errors };
  } finally {
    process.argv = originalArgs;
    console.error = originalError;
  }
}

describe("cmdEscalate dispatch", () => {
  it("refuses a merge denial without the pull request category", async () => {
    const result = await runWithArgs(["escalate", "--merge-denied"]);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /requires kit escalate pr/);
  });

  it("refuses an unexpected pull request subcommand", async () => {
    const result = await runWithArgs(["escalate", "pr", "unexpected"]);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Use: kit escalate pr/);
  });
});
