import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getPolicyPath, getPolicySigPath } from "./policy-doc.js";
import { applyPolicyPairAtomically } from "./policy-pull.js";

it("policy rollback does not follow a link inserted during signature restore", () => {
  const dest = mkdtempSync(join(tmpdir(), "kit-policy-rollback-race-"));
  try {
    const oldSignature = Buffer.from("old signature bytes\n");
    const unrelated = join(dest, "unrelated");
    writeFileSync(getPolicyPath(dest), "old policy bytes\n");
    writeFileSync(getPolicySigPath(dest), oldSignature);
    writeFileSync(unrelated, "leave this file alone\n");
    let calls = 0;

    const result = applyPolicyPairAtomically(
      dest,
      Buffer.from("new policy bytes\n"),
      Buffer.from("new signature bytes\n"),
      (from, to) => {
        calls++;
        if (calls === 2) {
          rmSync(getPolicySigPath(dest));
          symlinkSync(unrelated, getPolicySigPath(dest));
          throw Object.assign(new Error("injected failure"), { code: "EIO" });
        }
        renameSync(from, to);
      },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(readFileSync(unrelated), Buffer.from("leave this file alone\n"));
    assert.equal(lstatSync(getPolicySigPath(dest)).isFile(), true);
    assert.deepEqual(readFileSync(getPolicySigPath(dest)), oldSignature);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
