import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { releaseAge } from "./triage-release-deps.js";

const dir = tmpdir();

describe("kit triage release: cooling", () => {
  it("holds a release younger than the limit and passes an older one", async () => {
    const now = () => Date.parse("2026-11-26T00:00:00Z");
    const age = releaseAge(dir, { KIT_MIN_RELEASE_AGE_DAYS: "14" }, now);
    const young = await age("acme/tool", "v2", "2026-11-24T00:00:00Z");
    assert.equal(young.status, "fail");
    assert.match(young.detail, /published 2 days ago, limit 14/);
    const old = await age("acme/tool", "v1", "2026-10-01T00:00:00Z");
    assert.equal(old.status, "pass");
    const warn = releaseAge(dir, { KIT_MIN_RELEASE_AGE_DAYS: "14", KIT_COOLING_ENFORCE: "0" }, now);
    assert.equal((await warn("acme/tool", "v2", "2026-11-24T00:00:00Z")).status, "pass");
  });
});
