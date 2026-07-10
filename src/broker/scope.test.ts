import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hostInScope, pathInScope, secretInScope, isLoopbackOrPrivate } from "./scope.js";
import type { ProfileScope } from "../profile/schema.js";

describe("hostInScope", () => {
  const scope: ProfileScope = { egress: ["api.acme.com", "acme.io"] };

  it("allows an exact allowlisted host", () => {
    assert.equal(hostInScope("api.acme.com", scope), true);
  });
  it("allows a subdomain of an allowlisted entry", () => {
    assert.equal(hostInScope("eu.acme.io", scope), true);
    assert.equal(hostInScope("a.b.acme.io", scope), true);
  });
  it("denies an unrelated host and a sibling/suffix trick", () => {
    assert.equal(hostInScope("evil.com", scope), false);
    assert.equal(hostInScope("notacme.io", scope), false); // suffix without a dot boundary
    assert.equal(hostInScope("acme.io.evil.com", scope), false);
  });
  it("denies everything when egress is undefined or empty", () => {
    assert.equal(hostInScope("api.acme.com", {}), false);
    assert.equal(hostInScope("api.acme.com", { egress: [] }), false);
  });
  it("never subdomain-matches loopback/private, but honors an exact listing", () => {
    assert.equal(hostInScope("127.0.0.1", { egress: ["0.0.0.1"] }), false);
    assert.equal(hostInScope("localhost", { egress: ["host"] }), false); // no subdomain match to loopback
    assert.equal(hostInScope("localhost", { egress: ["localhost"] }), true); // explicit wins
  });
  it("is case-insensitive and tolerates a trailing FQDN dot", () => {
    assert.equal(hostInScope("API.ACME.COM.", scope), true);
  });
});

describe("isLoopbackOrPrivate", () => {
  it("flags loopback, link-local, and RFC1918 ranges", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "192.168.0.5",
      "172.16.0.1",
      "169.254.1.1",
    ]) {
      assert.equal(isLoopbackOrPrivate(h), true, h);
    }
  });
  it("does not flag public hosts or 172.15/172.32 (outside the private block)", () => {
    for (const h of ["api.acme.com", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
      assert.equal(isLoopbackOrPrivate(h), false, h);
    }
  });
});

describe("pathInScope", () => {
  const root = "/proj";

  it("allows writes inside the default root when fs is unspecified", () => {
    assert.equal(pathInScope("src/x.ts", {}, root), true);
    assert.equal(pathInScope("/proj/src/x.ts", {}, root), true);
  });
  it("denies a traversal escape out of the root", () => {
    assert.equal(pathInScope("../etc/passwd", {}, root), false);
    assert.equal(pathInScope("/etc/passwd", {}, root), false);
  });
  it("honors an explicit fs sub-scope", () => {
    const scope: ProfileScope = { fs: ["src", "dist"] };
    assert.equal(pathInScope("src/a.ts", scope, root), true);
    assert.equal(pathInScope("dist/b.js", scope, root), true);
    assert.equal(pathInScope("secrets/c", scope, root), false);
  });
  it("treats the scope root itself as in-scope", () => {
    assert.equal(pathInScope(".", {}, root), true);
  });
});

describe("secretInScope", () => {
  it("permits only declared keys; empty/undefined ⇒ none", () => {
    assert.equal(secretInScope("DATABASE_URL", { secrets: ["DATABASE_URL"] }), true);
    assert.equal(secretInScope("AWS_SECRET", { secrets: ["DATABASE_URL"] }), false);
    assert.equal(secretInScope("ANY", {}), false);
    assert.equal(secretInScope("ANY", { secrets: [] }), false);
  });
});
