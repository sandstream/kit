import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextSchema } from "./config-context-schema.js";

describe("ContextSchema", () => {
  it("accepts a single project and a list of exact projects", () => {
    assert.ok(ContextSchema.safeParse({ gcloud: { project: "a" } }).success);
    assert.ok(ContextSchema.safeParse({ gcloud: { project: ["a", "b"] } }).success);
  });

  it("is optional", () => {
    assert.ok(ContextSchema.safeParse(undefined).success);
  });

  it("keeps unknown tools and keys, so `kit context check` can report them as unchecked", () => {
    const r = ContextSchema.safeParse({ terraformm: { bucket: "b" }, gcloud: { projct: "p" } });
    assert.ok(r.success);
    assert.deepEqual(r.data, { terraformm: { bucket: "b" }, gcloud: { projct: "p" } });
  });

  it("rejects a value of the wrong type", () => {
    assert.ok(!ContextSchema.safeParse({ git: { email: 1 } }).success);
  });
});
