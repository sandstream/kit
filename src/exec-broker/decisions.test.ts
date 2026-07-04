import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { checkEgress, checkFsWrite, scopeEnv } from "./decisions.js";

describe("checkEgress", () => {
  it("permits an exact host from a full URL", () => {
    assert.equal(checkEgress("https://api.example.com/x", { allow: ["api.example.com"] }).ok, true);
  });

  it("permits a bare host (no scheme)", () => {
    assert.equal(checkEgress("api.example.com", { allow: ["api.example.com"] }).ok, true);
  });

  it("permits host with port and userinfo (compares hostname only)", () => {
    assert.equal(
      checkEgress("http://user:pw@api.example.com:8080/p", { allow: ["api.example.com"] }).ok,
      true,
    );
  });

  it("denies a host not in the allowlist", () => {
    assert.equal(checkEgress("https://evil.com", { allow: ["api.example.com"] }).ok, false);
  });

  it("denies the suffix-spoof host api.example.com.evil.com", () => {
    assert.equal(
      checkEgress("http://api.example.com.evil.com", { allow: ["api.example.com"] }).ok,
      false,
    );
  });

  it("empty allowlist denies everything (default-deny)", () => {
    assert.equal(checkEgress("https://api.example.com", { allow: [] }).ok, false);
  });

  it("malformed targets are denied, never throw", () => {
    assert.equal(checkEgress("::::", { allow: ["api.example.com"] }).ok, false);
    assert.equal(checkEgress("", { allow: ["api.example.com"] }).ok, false);
  });

  it("host match is case-insensitive", () => {
    assert.equal(checkEgress("https://API.Example.COM", { allow: ["api.example.com"] }).ok, true);
    assert.equal(checkEgress("https://api.example.com", { allow: ["API.EXAMPLE.COM"] }).ok, true);
  });

  it("dot-prefixed entry is a subdomain suffix match", () => {
    const allow = [".example.com"];
    assert.equal(checkEgress("https://api.example.com", { allow }).ok, true);
    assert.equal(checkEgress("https://example.com", { allow }).ok, true);
    assert.equal(checkEgress("https://api.example.com.evil.com", { allow }).ok, false);
    assert.equal(checkEgress("https://notexample.com", { allow }).ok, false);
  });

  it("ignores empty/non-string allow entries", () => {
    assert.equal(checkEgress("https://api.example.com", { allow: [""] }).ok, false);
  });
});

describe("checkFsWrite", () => {
  const root = resolve("/repo");

  it("permits a file directly under root", () => {
    assert.equal(checkFsWrite(`${root}${sep}a.txt`, root).ok, true);
  });

  it("permits root itself", () => {
    assert.equal(checkFsWrite(root, root).ok, true);
  });

  it("permits a nested path under root", () => {
    assert.equal(checkFsWrite(`${root}${sep}a${sep}b${sep}c.txt`, root).ok, true);
  });

  it("resolves a relative path against root", () => {
    assert.equal(checkFsWrite("a.txt", root).ok, true);
  });

  it("denies '..' traversal that escapes root", () => {
    assert.equal(checkFsWrite(`${root}${sep}..${sep}etc${sep}passwd`, root).ok, false);
    assert.equal(checkFsWrite("../outside", root).ok, false);
  });

  it("denies an absolute path outside root", () => {
    assert.equal(checkFsWrite(resolve("/etc/passwd"), root).ok, false);
  });

  it("denies the prefix-without-separator escape (/repofoo vs /repo)", () => {
    assert.equal(checkFsWrite(resolve("/repofoo/x"), root).ok, false);
  });

  it("never throws on odd input", () => {
    assert.equal(typeof checkFsWrite("", root).ok, "boolean");
  });
});

describe("scopeEnv", () => {
  it("returns only declared keys that are present", () => {
    assert.deepEqual(scopeEnv(["A", "B"], { A: "1", C: "3" }), { A: "1" });
  });

  it("empty declared yields empty object", () => {
    assert.deepEqual(scopeEnv([], { A: "1" }), {});
  });

  it("omits undefined-valued declared keys", () => {
    assert.deepEqual(scopeEnv(["A", "B"], { A: "1", B: undefined }), { A: "1" });
  });

  it("does NOT mutate the input env object", () => {
    const full = { A: "1", C: "3" };
    const before = { ...full };
    scopeEnv(["A"], full);
    assert.deepEqual(full, before);
  });

  it("returns a NEW object, not a reference to input", () => {
    const full = { A: "1" };
    const out = scopeEnv(["A"], full);
    assert.notEqual(out, full);
  });
});
