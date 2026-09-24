import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveKitRoot, runSelfAudit } from "./self-audit.js";

describe("keystone: kit self-audits clean", () => {
  it("runSelfAudit over the current kit tree returns ZERO fail results", () => {
    const root = resolveKitRoot();
    assert.ok(root, "kit root must resolve for the keystone");
    assert.ok(existsSync(join(root!, "src")), "kit src/ must exist");
    const res = runSelfAudit(root!);
    const fails = res.filter((r) => r.status === "fail");
    assert.equal(
      fails.length,
      0,
      `expected 0 fail, got ${fails.length}:\n` +
        fails.map((f) => `  ${f.category} ${(f.files ?? []).join(",")} — ${f.detail}`).join("\n"),
    );
  });
});
