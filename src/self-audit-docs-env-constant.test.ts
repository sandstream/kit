/**
 * A `KIT_*` name held in a constant (`const SIGN_CMD_ENV = "KIT_KEYSTORE_SIGN_CMD";`) and read
 * later through `process.env[SIGN_CMD_ENV]` is read by the implementation. The documented-env
 * rule used to miss that form, so a doc naming such a variable failed self-audit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnownEnvVars } from "./self-audit-docs.js";

describe("self-audit-docs: env var names held in constants", () => {
  it("counts a quoted KIT_ name assigned to a constant", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-envvars-const-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "a.ts"),
        'const SIGN_CMD_ENV = "KIT_NAMED_CONSTANT";\nconst v = process.env[SIGN_CMD_ENV];\n',
      );
      assert.ok(loadKnownEnvVars(root).has("KIT_NAMED_CONSTANT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
