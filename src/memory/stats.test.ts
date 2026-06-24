import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeTokens, sparkline, fmtTokens } from "./stats.js";

describe("summarizeTokens", () => {
  it("sums totalTokens (input+output) and computes cache-hit ratio", () => {
    const s = summarizeTokens({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
    });
    assert.equal(s.totalTokens, 150);
    // cacheRead / (input + cacheRead + cacheCreation) = 300 / 500 = 0.6
    assert.equal(s.cacheHitRatio, 0.6);
  });

  it("returns null cache-hit ratio when there is no token data (avoids misleading 0%)", () => {
    const s = summarizeTokens({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    assert.equal(s.cacheHitRatio, null);
    assert.equal(s.totalTokens, 0);
  });

  it("ratio is null when input exists but NO cache tokens were recorded (forward-only history)", () => {
    // Historical rows have input_tokens but NULL cache cols → don't report a
    // misleading 0%; n/a until cache data accumulates.
    const s = summarizeTokens({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    assert.equal(s.cacheHitRatio, null);
  });

  it("ratio reflects a true 0% only once some cache activity is present", () => {
    // cache_creation happened (cache was written) but nothing was read back.
    const s = summarizeTokens({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 100,
    });
    assert.equal(s.cacheHitRatio, 0); // 0 / (100+0+100)
  });
});

describe("sparkline", () => {
  it("returns empty for no data", () => {
    assert.equal(sparkline([]), "");
  });

  it("maps the busiest day to the densest glyph and zero-days to blanks", () => {
    const out = sparkline([0, 1, 10]);
    assert.equal(out.length, 3);
    assert.equal(out[0], " "); // zero day → blank
    assert.equal(out[2], "█"); // max day → densest
    assert.notEqual(out[1], " "); // a non-zero day is never blank
  });

  it("all-zero input renders all blanks (no divide-by-zero)", () => {
    assert.equal(sparkline([0, 0, 0]), "   ");
  });
});

describe("fmtTokens", () => {
  it("formats millions, thousands, and raw", () => {
    assert.equal(fmtTokens(87_600_000), "87.6m");
    assert.equal(fmtTokens(12_345), "12.3k");
    assert.equal(fmtTokens(629), "629");
  });
});
