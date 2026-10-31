/**
 * A `KIT_*` name held in a constant (`const SIGN_CMD_ENV = "KIT_KEYSTORE_SIGN_CMD";`) and read
 * later through `process.env[SIGN_CMD_ENV]` is read by the implementation. The documented-env
 * rule used to miss that form, so a doc naming such a variable failed self-audit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnownEnvVars } from "./self-audit-docs.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

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
      rmTemp(root);
    }
  });

  it("counts a name read by an npm script in scripts/, but not by a script's own test", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-envvars-scripts-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "test.mjs"), "const c = process.env.KIT_FROM_SCRIPT;\n");
      writeFileSync(join(root, "scripts", "x.test.mjs"), "process.env.KIT_SCRIPT_TEST_ONLY;\n");
      const known = loadKnownEnvVars(root);
      assert.ok(known.has("KIT_FROM_SCRIPT"));
      assert.equal(known.has("KIT_SCRIPT_TEST_ONLY"), false);
    } finally {
      rmTemp(root);
    }
  });
});
