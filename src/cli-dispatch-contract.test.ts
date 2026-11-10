import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

let fixture: ReturnType<typeof createCliContractFixture>;
beforeEach(() => {
  fixture = createCliContractFixture();
});
afterEach(() => fixture.cleanup());

for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
  it(`refuses the undeclared command ${name} without state changes`, () => {
    const before = fixture.snapshot();
    const result = fixture.run([name]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unknown command/);
    assert.equal(result.stdout, "");
    assert.deepEqual(fixture.snapshot(), before);
  });

  it(`refuses help for the undeclared command ${name}`, () => {
    const result = fixture.run(["help", name]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unknown command/);
  });
}

it("continues to dispatch a declared command", () => {
  const result = fixture.run(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\n$/);
});
