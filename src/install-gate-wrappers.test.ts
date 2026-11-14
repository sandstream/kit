import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wrapperCommandStart } from "./install-gate-wrappers.js";

describe("wrapperCommandStart", () => {
  it("skips a wrapper flag and stops at the command", () => {
    const unverifiable: string[] = [];
    assert.equal(wrapperCommandStart(["env", "-i", "npm", "i"], 1, "env", unverifiable), 2);
    assert.deepEqual(unverifiable, []);
  });

  it("skips an option value, so the value is not read as the command", () => {
    const unverifiable: string[] = [];
    assert.equal(
      wrapperCommandStart(["sudo", "-u", "bob", "npm", "i"], 1, "sudo", unverifiable),
      3,
    );
    assert.deepEqual(unverifiable, []);
  });

  it("marks `env -S` unverifiable because it carries a whole command line", () => {
    const unverifiable: string[] = [];
    wrapperCommandStart(["env", "-S", "npm i x"], 1, "env", unverifiable);
    assert.deepEqual(unverifiable, ["wrapper-command:env split-string"]);
  });
});
