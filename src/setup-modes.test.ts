import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODES, MODE_NAMES, resolveMode, modeScore, type SubsystemStatus } from "./setup-modes.js";

describe("setup-modes", () => {
  it("every mode has a coherent profile (label matches key, non-empty expects + blurb)", () => {
    for (const name of MODE_NAMES) {
      const p = MODES[name];
      assert.equal(p.mode, name);
      assert.equal(p.label, name);
      assert.ok(p.expects.length > 0, `${name} should expect ≥1 subsystem`);
      assert.ok(p.blurb.length > 0, `${name} needs a blurb`);
      if (p.posture)
        assert.ok(["connected", "airgap"].includes(p.posture), `${name} posture valid`);
    }
  });

  it("review mode is read-only and writes nothing", () => {
    const r = MODES.review;
    assert.equal(r.readOnly, true);
    assert.deepEqual([r.install, r.login, r.secrets, r.hooks], [false, false, false, false]);
  });

  it("airgap forces the air-gapped posture; full leaves it to prompt", () => {
    assert.equal(MODES.airgap.posture, "airgap");
    assert.equal(MODES.full.posture, null);
  });

  it("resolveMode: flag > config > full default", () => {
    assert.equal(resolveMode("airgap", "ci").profile.mode, "airgap"); // flag wins
    assert.equal(resolveMode(undefined, "ci").profile.mode, "ci"); // config when no flag
    assert.equal(resolveMode(undefined, undefined).profile.mode, "full"); // default
  });

  it("resolveMode: unknown name falls back to full and is flagged not-recognized", () => {
    const r = resolveMode("bogus", undefined);
    assert.equal(r.profile.mode, "full");
    assert.equal(r.recognized, false);
    assert.equal(r.requested, "bogus");
    // a recognized request reports recognized=true; absent request also "recognized" (= default ok)
    assert.equal(resolveMode("AIRGAP", undefined).recognized, true); // case-insensitive
    assert.equal(resolveMode(undefined, undefined).recognized, true);
  });

  it("modeScore counts only the mode's expected subsystems and lists the gaps", () => {
    const statuses: SubsystemStatus[] = [
      { key: "config", label: "c", ok: true },
      { key: "tools", label: "t", ok: false, next: "kit install" },
      { key: "secrets", label: "s", ok: true },
      { key: "memory", label: "m", ok: false }, // not expected by `local` → ignored
    ];
    const score = modeScore(MODES.local, statuses); // local expects config,tools,secrets,hooks
    assert.equal(score.total, 3); // config, tools, secrets present in statuses (hooks absent from list)
    assert.equal(score.done, 2); // config + secrets ok
    assert.deepEqual(
      score.gaps.map((g) => g.key),
      ["tools"],
    );
  });
});
