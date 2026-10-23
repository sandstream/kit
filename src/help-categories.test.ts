import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HELP_CATEGORIES } from "./help-categories.js";

describe("HELP_CATEGORIES", () => {
  it("has named groups that each list at least one command", () => {
    assert.ok(HELP_CATEGORIES.length > 0);
    for (const [title, commands] of HELP_CATEGORIES) {
      assert.ok(title.length > 0);
      assert.ok(commands.length > 0, title);
    }
  });

  it("lists no command twice", () => {
    const all = HELP_CATEGORIES.flatMap(([, commands]) => commands);
    assert.equal(new Set(all).size, all.length);
  });

  it("lists the upstream command under security and supply chain", () => {
    const group = HELP_CATEGORIES.find(([title]) => title === "Security & supply chain");
    assert.ok(group?.[1].includes("upstream"));
  });
});
