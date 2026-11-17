import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { slopRules } from "./self-audit-slop.js";
import { SELF_AUDIT_RULES } from "./self-audit.js";

describe("self-audit-slop — registration", () => {
  it("defines both rules as error-severity and enabled", () => {
    const rules = slopRules(() => 0);
    assert.deepEqual(
      rules.map((r) => `${r.id}:${r.severity}:${r.enabled}`),
      ["R16-unreferenced-exports:error:true", "R17-count-claims:error:true"],
    );
  });

  it("is in the self-audit rule table", () => {
    const ids = SELF_AUDIT_RULES.map((r) => r.id);
    assert.ok(ids.includes("R16-unreferenced-exports"));
    assert.ok(ids.includes("R17-count-claims"));
  });

  it("is listed by `kit self-audit --list-rules`", () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const out = spawnSync(process.execPath, [cli, "self-audit", "--list-rules"], {
      encoding: "utf8",
    }).stdout;
    assert.match(out, /R16-unreferenced-exports/);
    assert.match(out, /R17-count-claims/);
  });
});
