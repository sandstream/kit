import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdEscalatePr } from "./escalate-pr.js";

it("refuses to write a PR handoff in read-only mode", async () => {
  const cwd = process.cwd();
  const previousMode = process.env.KIT_READ_ONLY;
  const previousAnchor = process.env.KIT_AUDIT_ANCHOR;
  const originalError = console.error;
  const errors: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "kit-escalate-pr-read-only-"));
  try {
    writeFileSync(join(root, ".kit.toml"), "# empty config\n");
    process.chdir(root);
    process.env.KIT_READ_ONLY = "1";
    process.env.KIT_AUDIT_ANCHOR = "0";
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
    assert.equal(await cmdEscalatePr(), false);
    assert.equal(existsSync(join(root, ".kit-escalation.txt")), false);
    assert.match(errors.join("\n"), /read-only mode active/);
  } finally {
    process.chdir(cwd);
    if (previousMode === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previousMode;
    if (previousAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR;
    else process.env.KIT_AUDIT_ANCHOR = previousAnchor;
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});
