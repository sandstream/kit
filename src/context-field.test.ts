import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { field, activationProject } from "./context-field.js";

describe("field", () => {
  it("does not check an undeclared value", () => {
    assert.equal(field("gcloud", "project", undefined, "x"), null);
  });

  it("matches a single declared value exactly", () => {
    assert.equal(field("gcloud", "project", "a", "a")?.status, "ok");
    assert.equal(field("gcloud", "project", "a", "a-old")?.status, "mismatch");
  });

  it("matches a list of exact names and shows them joined", () => {
    const f = field("gcloud", "project", ["a", "b"], "b");
    assert.equal(f?.status, "ok");
    assert.equal(f?.expected, "a | b");
    assert.equal(field("gcloud", "project", ["a", "b"], "ab")?.status, "mismatch");
  });

  it("is unknown when the live value cannot be read", () => {
    assert.equal(field("gcloud", "project", ["a"], null)?.status, "unknown");
  });

  it("an empty list matches nothing", () => {
    const f = field("gcloud", "project", [], "a");
    assert.equal(f?.status, "mismatch");
    assert.equal(f?.expected, "(empty list)");
  });
});

describe("activationProject", () => {
  it("returns a single value, a one-item list, and nothing for several", () => {
    assert.equal(activationProject({ project: "a" }), "a");
    assert.equal(activationProject({ project: ["a"] }), "a");
    assert.equal(activationProject({ project: ["a", "b"] }), undefined);
    assert.equal(activationProject({}), undefined);
    assert.equal(activationProject(undefined), undefined);
  });
});
