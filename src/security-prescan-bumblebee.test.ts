import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrescan } from "./security-prescan.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("reports unavailable Bumblebee only when the selected checks use it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "prescan-missing-scanner-"));
  const previous = process.env.KIT_BUMBLEBEE_BIN;
  process.env.KIT_BUMBLEBEE_BIN = join(root, "absent-scanner");
  t.after(() => {
    if (previous === undefined) delete process.env.KIT_BUMBLEBEE_BIN;
    else process.env.KIT_BUMBLEBEE_BIN = previous;
    rmTemp(root);
  });
  const opts = { root, deep: true, persist: false };
  const selected = await runPrescan({ ...opts, onlyChecks: ["bumblebee"] });
  assert.equal(selected.findings.length, 1);
  assert.match(selected.findings[0].detail, /Bumblebee scan unavailable/);
  const skipped = await runPrescan({ ...opts, onlyChecks: ["different-check"] });
  assert.deepEqual(skipped.findings, []);
});
