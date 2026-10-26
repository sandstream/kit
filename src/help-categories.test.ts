import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HELP_CATEGORIES } from "./help-categories.js";
import { COMMANDS, COMMAND_AUDIENCE } from "./cli.js";

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

  it('puts every dispatched command in a group, so nothing lands under "Other"', () => {
    const grouped = new Set(HELP_CATEGORIES.flatMap(([, commands]) => commands));
    // Harness commands (gate-*, statusline) are hidden from default help on purpose.
    const ungrouped = Object.keys(COMMANDS).filter(
      (verb) => !grouped.has(verb) && COMMAND_AUDIENCE[verb] !== "harness",
    );
    assert.deepEqual(ungrouped, []);
  });
});
