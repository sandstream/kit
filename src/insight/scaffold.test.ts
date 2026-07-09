import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify, scaffoldFromCandidate } from "./scaffold.js";
import type { LearnCandidate } from "../memory/learn.js";

const cand = (over: Partial<LearnCandidate> = {}): LearnCandidate => ({
  normalized: "run the tests before committing",
  example: "Run the tests before committing",
  count: 5,
  sessions: 3,
  correction: false,
  ...over,
});

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics to single dashes, trims", () => {
    assert.equal(slugify("Run the tests before committing!"), "run-the-tests-before-committing");
    assert.equal(slugify("  Foo / Bar__baz  "), "foo-bar-baz");
  });
  it("falls back for empty/symbol-only input", () => {
    assert.equal(slugify(""), "recurring-instruction");
    assert.equal(slugify("!!!"), "recurring-instruction");
  });
  it("caps length and has no trailing dash", () => {
    const s = slugify("a".repeat(80) + " !!!");
    assert.ok(s.length <= 60);
    assert.ok(!s.endsWith("-"));
  });
});

describe("scaffoldFromCandidate", () => {
  it("produces a .draft.md skeleton with frontmatter, intent, and recurrence", () => {
    const { filename, content } = scaffoldFromCandidate(cand());
    assert.equal(filename, "run-the-tests-before-committing.skill.draft.md");
    assert.match(content, /^---\nname: run-the-tests-before-committing\n/);
    assert.match(content, /DRAFT/);
    assert.match(content, /Run the tests before committing/); // intent = example
    assert.match(content, /\*\*5×\*\* across \*\*3 sessions\*\*/);
    assert.match(content, /## Steps/);
  });
  it("is deterministic (no timestamps/randomness) — same candidate, same output", () => {
    assert.deepEqual(scaffoldFromCandidate(cand()), scaffoldFromCandidate(cand()));
  });
  it("notes the correction signal and singular session", () => {
    const { content } = scaffoldFromCandidate(cand({ sessions: 1, correction: true, count: 2 }));
    assert.match(content, /\*\*2×\*\* across \*\*1 session\*\*/);
    assert.match(content, /correction/);
  });
});
