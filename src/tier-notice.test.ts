import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tierNotice, EXECUTING_CATEGORIES, type JsonCheck } from "./cli-checks-shared.js";

const check = (category: string): JsonCheck => ({
  name: `${category} check`,
  status: "pass",
  detail: "",
  category,
});

describe("tierNotice", () => {
  it("counts the tiers rather than asserting them, so it cannot go stale", () => {
    const notice = tierNotice([
      check("security/secrets"),
      check("security/supply-chain"),
      check("tests"),
    ]);
    assert.match(notice, /3 check\(s\)/);
    assert.match(notice, /2 inspect the code/);
    assert.match(notice, /1 executes it/);
  });

  it("says none execute the code when no executing category ran", () => {
    // The case that matters: a run made entirely of static checks must not leave the
    // reader thinking anything was actually run.
    const notice = tierNotice([check("security/secrets"), check("deploy")]);
    assert.match(notice, /2 inspect the code, none execute the code/);
  });

  it("names the runtime tier, so the limitation comes with its remedy", () => {
    assert.match(tierNotice([check("tests")]), /kit broker/);
  });

  it("returns nothing for an empty run — there is no scope to state", () => {
    assert.equal(tierNotice([]), "");
  });

  it("derives the split from EXECUTING_CATEGORIES, not from a hardcoded count", () => {
    // Proves the notice tracks the constant: every category listed there counts as
    // executing, and a category absent from it counts as static.
    for (const cat of EXECUTING_CATEGORIES) {
      assert.match(tierNotice([check(cat)]), /0 inspect the code, 1 executes it/);
    }
    assert.match(tierNotice([check("not-a-real-category")]), /1 inspect the code/);
  });
});
