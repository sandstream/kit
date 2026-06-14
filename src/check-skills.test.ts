import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkSkills } from "./check-skills.js";

// Override the skills base path by patching the module's SKILLS_BASE constant
// Since it's not injectable, we test observable behavior via temp directories
// and the real filesystem behavior for missing skills

describe("checkSkills", () => {
  it("returns empty array when no skills configured", async () => {
    const results = await checkSkills({ required: {}, optional: {} });
    assert.deepEqual(results, []);
  });

  it("marks required skills correctly", async () => {
    const results = await checkSkills({
      required: { "nonexistent-skill-xyz": "1.0.0" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "nonexistent-skill-xyz");
    assert.equal(results[0].required, true);
    assert.equal(results[0].versionSpec, "1.0.0");
  });

  it("marks optional skills correctly", async () => {
    const results = await checkSkills({
      optional: { "nonexistent-optional-skill": "^2.0" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "nonexistent-optional-skill");
    assert.equal(results[0].required, false);
    assert.equal(results[0].versionSpec, "^2.0");
  });

  it("reports not installed for skills that do not exist", async () => {
    const results = await checkSkills({
      required: { "skill-that-does-not-exist-xyz": "1.0.0" },
    });

    assert.equal(results[0].installed, false);
  });

  it("checks both required and optional skills", async () => {
    const results = await checkSkills({
      required: { "req-skill-xyz": "1.0.0" },
      optional: { "opt-skill-xyz": "2.0.0" },
    });

    assert.equal(results.length, 2);
    const req = results.find((r) => r.name === "req-skill-xyz")!;
    const opt = results.find((r) => r.name === "opt-skill-xyz")!;

    assert.equal(req.required, true);
    assert.equal(opt.required, false);
    assert.equal(req.installed, false);
    assert.equal(opt.installed, false);
  });

  it("handles undefined required and optional gracefully", async () => {
    const results = await checkSkills({});
    assert.deepEqual(results, []);
  });
});
