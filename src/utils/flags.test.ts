import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasFlag, flagValue, flagInt } from "./flags.js";

describe("flag helpers", () => {
  describe("hasFlag", () => {
    it("detects a present flag", () => {
      assert.equal(hasFlag(["a", "--json", "b"], "--json"), true);
    });
    it("returns false when absent", () => {
      assert.equal(hasFlag(["a", "b"], "--json"), false);
    });
    it("matches any of several aliases", () => {
      assert.equal(hasFlag(["-y"], "--yes", "-y"), true);
      assert.equal(hasFlag(["--yes"], "--yes", "-y"), true);
      assert.equal(hasFlag(["--no"], "--yes", "-y"), false);
    });
  });

  describe("flagValue", () => {
    it("reads space-separated --flag value", () => {
      assert.equal(flagValue(["--service", "vercel"], "--service"), "vercel");
    });
    it("reads --flag=value form", () => {
      assert.equal(flagValue(["--service=vercel"], "--service"), "vercel");
    });
    it("returns undefined when absent", () => {
      assert.equal(flagValue(["--other", "x"], "--service"), undefined);
    });
    it("returns undefined when flag is the final token", () => {
      assert.equal(flagValue(["a", "--service"], "--service"), undefined);
    });
    it("inline form wins and preserves '=' in the value", () => {
      assert.equal(flagValue(["--kv=a=b"], "--kv"), "a=b");
    });
  });

  describe("flagInt", () => {
    it("parses an integer value", () => {
      assert.equal(flagInt(["--ttl-minutes", "30"], "--ttl-minutes", 5), 30);
    });
    it("falls back when absent", () => {
      assert.equal(flagInt([], "--ttl-minutes", 5), 5);
    });
    it("falls back when non-numeric", () => {
      assert.equal(flagInt(["--ttl-minutes", "soon"], "--ttl-minutes", 5), 5);
    });
  });
});
