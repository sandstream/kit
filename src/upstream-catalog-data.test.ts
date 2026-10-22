import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UPSTREAM_CATALOG_DATA } from "./upstream-catalog-data.js";
import { validateUpstreamCatalog } from "./upstream-catalog.js";

describe("UPSTREAM_CATALOG_DATA", () => {
  it("is a valid catalog", () => {
    assert.doesNotThrow(() => validateUpstreamCatalog(UPSTREAM_CATALOG_DATA));
  });

  it("names no customer or project", () => {
    const text = JSON.stringify(UPSTREAM_CATALOG_DATA);
    assert.ok(!/[A-Z]{2,}\.internal|localhost|\/Users\//.test(text));
  });
});
