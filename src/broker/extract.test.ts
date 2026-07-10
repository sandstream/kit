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
});
