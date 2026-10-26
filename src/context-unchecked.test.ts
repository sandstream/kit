import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uncheckedContext } from "./context-unchecked.js";
import type { ContextConfig } from "./config.js";

const cfg = (o: unknown): ContextConfig => o as ContextConfig;

describe("uncheckedContext", () => {
  it("reports nothing when every declared key is one kit checks", () => {
    assert.deepEqual(
      uncheckedContext(cfg({ gcloud: { account: "a", project: "p" }, git: { email: "e" } })),
      [],
    );
  });

  it("reports a whole tool section kit does not know", () => {
    const f = uncheckedContext(cfg({ terraformm: { bucket: "b" } }));
    assert.equal(f.length, 1);
    assert.equal(f[0].tool, "terraformm");
    assert.equal(f[0].status, "unchecked");
  });

  it("reports a misspelled key inside a known tool", () => {
    const f = uncheckedContext(cfg({ gcloud: { projct: "p", account: "a" } }));
    assert.equal(f.length, 1);
    assert.equal(f[0].tool, "gcloud");
    assert.equal(f[0].field, "projct");
    assert.equal(f[0].status, "unchecked");
  });

  it("never echoes a value into the finding text beyond the key", () => {
    const f = uncheckedContext(cfg({ gcloud: { token: "sekret-value" } }));
    assert.ok(!JSON.stringify(f).includes("sekret-value"));
  });
});
