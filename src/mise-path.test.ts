import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  miseShimsDir,
  isDirOnPath,
  activationLine,
  profileNeedsActivation,
  ensureMiseActivation,
} from "./mise-path.js";

describe("mise-path helpers", () => {
  const shims = miseShimsDir("/home/u");

  it("miseShimsDir + activationLine", () => {
    assert.equal(shims, "/home/u/.local/share/mise/shims");
    assert.equal(activationLine(shims), 'export PATH="/home/u/.local/share/mise/shims:$PATH"');
  });

  it("isDirOnPath matches exact entries only", () => {
    assert.equal(isDirOnPath(`/usr/bin:${shims}:/bin`, shims), true);
    assert.equal(isDirOnPath("/usr/bin:/bin", shims), false);
  });

  it("profileNeedsActivation: true when absent, false if shims dir or `mise activate` present", () => {
    assert.equal(profileNeedsActivation("export PATH=/usr/bin", shims), true);
    assert.equal(profileNeedsActivation(`x\n${activationLine(shims)}\n`, shims), false);
    assert.equal(profileNeedsActivation('eval "$(mise activate zsh)"', shims), false);
  });
});

describe("ensureMiseActivation (idempotent file append)", () => {
  it("adds once, then is a no-op", () => {
    const f = join(tmpdir(), `kit-mp-${process.pid}.zshrc`);
    writeFileSync(f, "# my profile\nexport PATH=/usr/bin\n");
    const shims = "/home/u/.local/share/mise/shims";
    try {
      assert.equal(ensureMiseActivation(f, shims), "added");
      assert.ok(readFileSync(f, "utf8").includes(shims));
      assert.equal(ensureMiseActivation(f, shims), "already"); // idempotent
    } finally {
      rmSync(f, { force: true });
    }
  });
});
