import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "./parseCommand.js";

describe("parseCommand", () => {
  it("classifies '#'-prefixed strings as informational", () => {
    const r = parseCommand("# resend — no CLI login; set RESEND_API_KEY");
    assert.equal(r.kind, "informational");
    if (r.kind === "informational") {
      assert.equal(r.message, "resend — no CLI login; set RESEND_API_KEY");
    }
  });

  it("strips leading whitespace before '#'", () => {
    const r = parseCommand("   # sentry guide");
    assert.equal(r.kind, "informational");
    if (r.kind === "informational") {
      assert.equal(r.message, "sentry guide");
    }
  });

  it("splits executable commands into cmd + args", () => {
    const r = parseCommand("stripe config --list");
    assert.equal(r.kind, "executable");
    if (r.kind === "executable") {
      assert.equal(r.cmd, "stripe");
      assert.deepEqual(r.args, ["config", "--list"]);
    }
  });

  it("handles single-word commands", () => {
    const r = parseCommand("whoami");
    assert.equal(r.kind, "executable");
    if (r.kind === "executable") {
      assert.equal(r.cmd, "whoami");
      assert.deepEqual(r.args, []);
    }
  });

  it("collapses multiple whitespace between tokens", () => {
    const r = parseCommand("  foo    bar   baz  ");
    assert.equal(r.kind, "executable");
    if (r.kind === "executable") {
      assert.equal(r.cmd, "foo");
      assert.deepEqual(r.args, ["bar", "baz"]);
    }
  });
});
