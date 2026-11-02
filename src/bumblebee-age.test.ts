import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_COVER, staleCatalogDetail } from "./bumblebee-age.js";

const newer = { latest: "0.2.0", pinned: "0.1.2" };

describe("staleCatalogDetail", () => {
  it("is a plain note while the catalogs are recent", () => {
    const text = staleCatalogDetail(12, 40, null);
    assert.match(text, /no known exposures \(12 packages\)/);
    assert.match(text, /40 days old/);
    assert.match(text, /advisory, not gated/);
    assert.doesNotMatch(text, /WARNING/);
  });

  it("warns that a pass says nothing about newer compromises once the catalogs are old", () => {
    const text = staleCatalogDetail(12, 135, null);
    assert.match(text, /WARNING/);
    assert.match(text, /135 days old/);
    assert.match(text, /not evidence about newer ones/);
  });

  it("says why the catalogs are old when no newer release exists", () => {
    const text = staleCatalogDetail(12, 135, null);
    assert.match(text, /no newer bumblebee release exists upstream/);
    assert.match(text, /main may hold newer entries this release cannot load/);
  });

  it("points at the newer release when there is one", () => {
    const text = staleCatalogDetail(12, 135, newer);
    assert.match(text, /bumblebee 0\.2\.0 is available upstream \(pinned 0\.1\.2\)/);
    assert.doesNotMatch(text, /no newer bumblebee release exists/);
  });

  it("switches wording after 90 days, not before", () => {
    assert.doesNotMatch(staleCatalogDetail(1, 90, null), /WARNING/);
    assert.match(staleCatalogDetail(1, 91, null), /WARNING/);
  });

  it("never uses an em-dash", () => {
    for (const age of [10, 135]) assert.doesNotMatch(staleCatalogDetail(1, age, newer), /—/);
  });
});

describe("LOCAL_COVER", () => {
  it("does not promise fresh threat data from bumblebee", () => {
    assert.match(LOCAL_COVER, /osv-scanner/);
    assert.match(LOCAL_COVER, /not live threat data/);
    assert.doesNotMatch(LOCAL_COVER, /—/);
  });
});
