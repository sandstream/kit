import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStatusline } from "./statusline.js";

describe("formatStatusline", () => {
  it("renders mode score + update + actions, dot-separated", () => {
    assert.equal(
      formatStatusline({ mode: "full", score: { done: 6, total: 6 }, update: "1.34.0", pal: 2 }),
      "kit:full 6/6 · update:1.34.0 · actions:2",
    );
  });

  it("omits the update segment when up to date, and actions when zero", () => {
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

  it("only an update / only actions render on their own", () => {
    assert.equal(formatStatusline({ update: "2.0.0" }), "update:2.0.0");
    assert.equal(formatStatusline({ pal: 3 }), "actions:3");
  });

  // The adoption nudge: a bare "kit:full 1/6" is true but actionless — the line
  // must say which SETUP step is next, exactly once, and only while incomplete.
  it("appends the next-step nudge when the score is incomplete", () => {
    assert.equal(
      formatStatusline({ mode: "full", score: { done: 1, total: 6 }, next: "kit init" }),
      "kit:full 1/6 · setup next:kit init",
    );
  });

  it("setup nudge rides before update/actions", () => {
    assert.equal(
      formatStatusline({
        mode: "full",
        score: { done: 2, total: 6 },
        update: "9.9.9",
        pal: 1,
        next: "kit install",
      }),
      "kit:full 2/6 · setup next:kit install · update:9.9.9 · actions:1",
    );
  });

  it("no nudge when complete, when no score shows, or when next is absent", () => {
    assert.equal(
      formatStatusline({ mode: "full", score: { done: 6, total: 6 }, next: "kit init" }),
      "kit:full 6/6",
    );
    assert.equal(formatStatusline({ next: "kit init" }), "");
    assert.equal(formatStatusline({ mode: "full", score: { done: 1, total: 6 } }), "kit:full 1/6");
  });
});
