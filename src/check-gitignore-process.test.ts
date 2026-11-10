import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gitignoreProcessProbe } from "./check-gitignore-process.test-support.js";

describe("Git ignore process evidence", { skip: process.platform === "win32" }, () => {
  it("preserves probe input when the parent resumes after Git starts", () => {
    const result = gitignoreProcessProbe("delayed-parent");
    assert.deepEqual(result.helper.missing, []);
    assert.equal(result.gate.status, "pass");
    assert.deepEqual(result.stdinErrors, []);
  });

  it("reports a broken input pipe as unverified, not four missing patterns", () => {
    const result = gitignoreProcessProbe("broken-pipe");
    assert.deepEqual(result.stdinErrors, ["EPIPE", "EPIPE"]);
    assert.match(result.helper.error ?? "", /input.*EPIPE.*could not be verified/);
    assert.equal(result.gate.didNotRun, true);
    assert.equal(result.gateStatus, "fail");
    assert.doesNotMatch(result.gate.detail, /default dotenv file/);
  });

  it("reports unreadable ignore rules as unverified", { skip: process.getuid?.() === 0 }, () => {
    const result = gitignoreProcessProbe("unreadable");
    assert.ok(result.stderr.some((text) => /unable to access.*gitignore/.test(text)));
    assert.match(result.helper.error ?? "", /read.*ignore.*could not be verified/);
    assert.equal(result.gate.didNotRun, true);
    assert.equal(result.gateStatus, "fail");
    assert.doesNotMatch(result.gate.detail, /default dotenv file/);
  });

  it("still reports real missing patterns on a clean exit 1", () => {
    const result = gitignoreProcessProbe("no-match");
    assert.deepEqual(result.helper.missing, [".env", ".env.local", ".env.*.local", ".env.keys"]);
    assert.equal(result.gate.status, "fail");
    assert.equal(result.gate.didNotRun, undefined);
    assert.match(result.gate.detail, /default dotenv file/);
  });

  it("allows Git trace diagnostics without hiding read errors", () => {
    const result = gitignoreProcessProbe("trace");
    assert.ok(result.stderr.some((text) => text.includes("trace:")));
    assert.deepEqual(result.helper.missing, []);
    assert.equal(result.gate.status, "pass");
  });

  it("keeps timeout classification when the child handles SIGTERM with exit 1", () => {
    const result = gitignoreProcessProbe("timeout");
    assert.match(result.helper.error ?? "", /Git check-ignore failed.*could not be verified/);
    assert.equal(result.gate.didNotRun, true);
    assert.equal(result.gateStatus, "fail");
  });
});
