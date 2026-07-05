import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateId, IdGenerators } from "./id-generator.js";

describe("generateId", () => {
  it("is unique, prefixed, and capped at 255 chars", () => {
    const a = generateId("approval-");
    const b = generateId("approval-");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("approval-"));
    assert.ok(a.length <= 255);
  });

  it("uses a cryptographically-strong (UUID) random component, not Math.random", () => {
    // A v4 UUID tail proves the strong-random source; `Math.random().toString(36)` never has
    // the 8-4-4-4-12 hyphen shape.
    const id = generateId("x");
    assert.match(id, /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // no collisions across a batch
    const seen = new Set(Array.from({ length: 1000 }, () => generateId("k-")));
    assert.equal(seen.size, 1000);
  });

  it("IdGenerators apply their domain prefix", () => {
    assert.ok(IdGenerators.approval().startsWith("approval-"));
    assert.ok(IdGenerators.trace("z").startsWith("trace-z"));
  });
});
