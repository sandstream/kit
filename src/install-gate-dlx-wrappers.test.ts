/** A dlx or bunx runner resolves the same wrapper chain as npx before it reads repository sources. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";

const FOREIGN = "https://foreign.example/o/r";

describe("dlx and bunx runners behind a command wrapper", () => {
  for (const runner of [
    "pnpm dlx --package=skills",
    "pnpm dlx -p skills",
    "bunx --package=skills",
    "yarn dlx -p skills",
  ]) {
    for (const wrapper of ["sudo", "nice -n 5", "env FLAG=1", "command", "timeout 5"]) {
      it(`refuses a foreign source behind ${wrapper}: ${runner}`, () => {
        const parsed = parseInstallCommand(`${runner} ${wrapper} skills add ${FOREIGN}`);
        assert.equal(parsed.isInstall, true);
        assert.deepEqual(parsed.unverifiable, [`repo-source:${FOREIGN}`]);
      });
    }
  }

  it("refuses a wrapper option it cannot read instead of guessing the child", () => {
    const parsed = parseInstallCommand(
      `pnpm dlx --package=skills sudo --unknown skills add ${FOREIGN}`,
    );
    assert.deepEqual(parsed.unverifiable, ["wrapper-option:sudo --unknown"]);
  });
});
