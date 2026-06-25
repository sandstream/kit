import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStatusline } from "./statusline.js";

describe("formatStatusline", () => {
  it("renders mode score + update + PAL, dot-separated", () => {
    assert.equal(
      formatStatusline({ mode: "full", score: { done: 6, total: 6 }, update: "1.34.0", pal: 2 }),
      "kit:full 6/6 · ⬆1.34.0 · ⚠2",
    );
  });

  it("omits the update segment when up to date, and PAL when zero", () => {
    assert.equal(
      formatStatusline({ mode: "airgap", score: { done: 4, total: 5 }, update: null, pal: 0 }),
      "kit:airgap 4/5",
    );
  });

  it("score without a mode drops the mode label", () => {
    assert.equal(formatStatusline({ score: { done: 1, total: 3 } }), "kit 1/3");
  });

  it("a total of 0 suppresses the score (but a mode alone still shows)", () => {
    assert.equal(
      formatStatusline({ mode: "minimal", score: { done: 0, total: 0 } }),
      "kit:minimal",
    );
  });

  it("empty input → empty string (bar shows nothing)", () => {
    assert.equal(formatStatusline({}), "");
  });

  it("only an update / only PAL render on their own", () => {
    assert.equal(formatStatusline({ update: "2.0.0" }), "⬆2.0.0");
    assert.equal(formatStatusline({ pal: 3 }), "⚠3");
  });
});
