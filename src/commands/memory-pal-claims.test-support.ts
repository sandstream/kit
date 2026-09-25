import assert from "node:assert/strict";
import type { PalView } from "../memory/pal-revisions.js";

export const CLAUDE = ["--harness", "claude-code", "--session", "claude-session"];
export const CODEX = ["--harness", "codex", "--session", "codex-session"];
export const FRONTIER = "0".repeat(64);

export async function rejectedJson(command: Promise<string>, code = 1) {
  let result: { status?: string; error?: string; ok?: boolean; view?: PalView } | undefined;
  await assert.rejects(command, (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error);
    assert.equal(error.code, code);
    assert.equal(typeof error.stdout, "string");
    result = JSON.parse(String(error.stdout));
    return true;
  });
  assert.ok(result);
  return result;
}
