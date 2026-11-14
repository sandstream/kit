import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnownEnvVars } from "./self-audit-docs.js";

// Kept apart from self-audit-docs.test.ts, which is at its frozen file size.
describe("self-audit-docs — loadKnownEnvVars over bash scripts", () => {
  it("counts a variable a bash script reads, as kit mcp web's wizard does", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-envvars-sh-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "scripts", "w.sh"),
        'if [[ "${KIT_SH_OPT_IN:-}" == "1" ]]; then echo "$KIT_SH_PLAIN"; fi\n# KIT_SH_IN_COMMENT\n',
        "utf-8",
      );
      const known = loadKnownEnvVars(root);
      assert.ok(known.has("KIT_SH_OPT_IN"));
      assert.ok(known.has("KIT_SH_PLAIN"));
      assert.equal(known.has("KIT_SH_IN_COMMENT"), false, "a bare mention is not a read");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
