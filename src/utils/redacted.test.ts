import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Redacted, redacted, isRedacted } from "./redacted.js";

describe("Redacted", () => {
  const secret = redacted("sk_live_supersecret");

  it("exposes the real value only via .expose()", () => {
    assert.equal(secret.expose(), "sk_live_supersecret");
  });

  it("masks on String() / template / toString", () => {
    assert.equal(String(secret), "<redacted>");
    assert.equal(`${secret}`, "<redacted>");
  });

  it("masks in JSON.stringify, including when nested in an object", () => {
    assert.equal(JSON.stringify(secret), '"<redacted>"');
    assert.equal(JSON.stringify({ apiKey: secret }), '{"apiKey":"<redacted>"}');
  });

  it("masks under util.inspect / console.log", () => {
    assert.match(inspect(secret), /<redacted>/);
    assert.doesNotMatch(inspect(secret), /supersecret/);
  });

  it("does not expose the value via own keys / Object spread", () => {
    assert.deepEqual(Object.keys(secret), []);
    assert.doesNotMatch(JSON.stringify({ ...secret }), /supersecret/);
  });

  it("isRedacted narrows correctly", () => {
    assert.equal(isRedacted(secret), true);
    assert.equal(isRedacted("plain"), false);
    assert.equal(isRedacted(new Redacted(123)), true);
  });

  it("works for non-string payloads", () => {
    const r = redacted({ token: "abc", n: 1 });
    assert.deepEqual(r.expose(), { token: "abc", n: 1 });
    assert.equal(String(r), "<redacted>");
  });
});
