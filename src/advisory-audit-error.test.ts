import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditJsonError } from "./advisory-baseline.js";

describe("auditJsonError", () => {
  it("reads the error object npm prints when the registry cannot be reached", () => {
    const text = JSON.stringify({ error: { code: "ENOTFOUND", summary: "request failed" } });
    assert.match(auditJsonError(text) ?? "", /ENOTFOUND/);
  });

  it("reads an error given as a string", () => {
    assert.match(auditJsonError('{"error":"boom"}') ?? "", /boom/);
  });

  it("returns nothing for a normal audit report", () => {
    assert.equal(auditJsonError('{"vulnerabilities":{},"metadata":{}}'), undefined);
  });

  it("returns nothing for text that is not a JSON object", () => {
    assert.equal(auditJsonError("not json"), undefined);
    assert.equal(auditJsonError("[1]"), undefined);
  });
});
