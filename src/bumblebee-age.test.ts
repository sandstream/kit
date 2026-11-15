import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_COVER,
  WARN_AFTER_DAYS,
  scannedHead,
  staleCatalogDetail,
  staleCatalogStatus,
} from "./bumblebee-age.js";

const newer = { latest: "0.2.0", pinned: "0.1.2" };

describe("scannedHead: what a clean scan covered", () => {
  it("says a baseline pass is about this machine, not the repository", () => {
    // Was: "no known exposures (86 packages)" in a project with no manifest at all; the
    // baseline profile reads only global and user package roots and agent configs.
    const text = scannedHead(86, "baseline");
    assert.match(text, /86 packages on this machine/);
    assert.match(text, /not this repository's dependencies/);
    assert.match(text, /KIT_BUMBLEBEE_PROFILE=project/);
  });

  it("names any other profile as it is", () => {
    assert.equal(scannedHead(5, "deep"), "no known exposures (5 packages, profile=deep)");
  });

  it("the stale-catalog detail keeps the scope, and defaults to baseline", () => {
    assert.match(staleCatalogDetail(86, 149, null), /on this machine \(baseline profile/);
  });
});

describe("staleCatalogDetail", () => {
  it("is a plain note while the catalogs are recent", () => {
    const text = staleCatalogDetail(12, 40, null, "project");
    assert.match(text, /no known exposures \(12 packages, profile=project\)/);
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

describe("staleCatalogStatus", () => {
  it("passes up to and including 180 days, warns after", () => {
    assert.equal(WARN_AFTER_DAYS, 180);
    assert.equal(staleCatalogStatus(0), "pass");
    assert.equal(staleCatalogStatus(180), "pass");
    assert.equal(staleCatalogStatus(181), "warn");
  });

  it("calls the warning a warning, not an advisory that is never gated", () => {
    assert.match(staleCatalogDetail(1, 181, null), /warning, not a failure/);
    assert.match(staleCatalogDetail(1, 135, null), /advisory, not gated/);
  });
});

describe("LOCAL_COVER", () => {
  it("does not promise fresh threat data from bumblebee", () => {
    assert.match(LOCAL_COVER, /osv-scanner/);
    assert.match(LOCAL_COVER, /not live threat data/);
    assert.doesNotMatch(LOCAL_COVER, /—/);
  });
});
