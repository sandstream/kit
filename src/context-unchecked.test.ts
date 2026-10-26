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

import { compareContext, planContext } from "./context-lock.js";

describe("gcloud.project as a list of exact names", () => {
  const live = (project: string | null) => ({ gcloud: { account: "a", project } });
  const declared = cfg({ gcloud: { project: ["acme-dev", "acme-stage", "acme-prod"] } });

  it("passes for each member", () => {
    for (const p of ["acme-dev", "acme-stage", "acme-prod"]) {
      assert.equal(compareContext(declared, live(p))[0].status, "ok");
    }
  });

  it("fails for any other project, also one that only starts with a member", () => {
    for (const p of ["acme-prod-old", "acme", "other"]) {
      assert.equal(compareContext(declared, live(p))[0].status, "mismatch");
    }
  });

  it("is unknown when the live project cannot be read", () => {
    assert.equal(compareContext(declared, live(null))[0].status, "unknown");
  });

  it("an empty list matches nothing", () => {
    assert.equal(
      compareContext(cfg({ gcloud: { project: [] } }), live("acme-dev"))[0].status,
      "mismatch",
    );
  });

  it("does not treat a glob as a pattern", () => {
    assert.equal(
      compareContext(cfg({ gcloud: { project: ["acme-*"] } }), live("acme-prod"))[0].status,
      "mismatch",
    );
  });

  it("activates only when the list names one project", () => {
    const one = planContext(cfg({ gcloud: { project: ["acme-dev"] } }));
    assert.ok(one.some((s) => s.argv.join(" ") === "config set project acme-dev"));
    const many = planContext(declared);
    assert.ok(!many.some((s) => s.argv.includes("project")));
  });
});
