import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { npmRangeAdmits, pep440Admits, singleNpmMajor } from "./runtime-range.js";

describe("npmRangeAdmits: an engines range, at Node-major granularity", () => {
  it("open lower bounds admit newer majors", () => {
    assert.equal(npmRangeAdmits(">=20.0.0", "22.22.0"), true);
    assert.equal(npmRangeAdmits(">=20", "18.19.0"), false);
    assert.equal(npmRangeAdmits(">20", "20.5.0"), false);
    assert.equal(npmRangeAdmits(">20.1.0", "20.5.0"), true);
  });

  it("unions, upper bounds, hyphens and wildcards", () => {
    assert.equal(npmRangeAdmits("^18 || >=20", "22.1.0"), true);
    assert.equal(npmRangeAdmits(">= 18 < 21", "22.1.0"), false);
    assert.equal(npmRangeAdmits(">=18 <21", "20.1.0"), true);
    assert.equal(npmRangeAdmits("18 - 20", "20.9.0"), true);
    assert.equal(npmRangeAdmits("18 - 20", "22.0.0"), false);
    assert.equal(npmRangeAdmits("*", "22.0.0"), true);
  });

  it("an unreadable range admits nothing", () => {
    assert.equal(npmRangeAdmits(">=latest", "22.0.0"), false);
    assert.equal(npmRangeAdmits(">=20", "not-a-version"), false);
  });
});

describe("pep440Admits: requires-python, at Python-minor granularity", () => {
  it("reads comma-joined clauses", () => {
    assert.equal(pep440Admits(">=3.10", "3.11.17"), true);
    assert.equal(pep440Admits(">=3.10,<3.13", "3.13.0"), false);
    assert.equal(pep440Admits("~=3.10", "3.12.1"), true);
    assert.equal(pep440Admits("==3.11.*", "3.11.4"), true);
    assert.equal(pep440Admits("==3.11.*", "3.12.0"), false);
    assert.equal(pep440Admits(">=3.10, !=3.11.*", "3.12.0"), true);
  });
});

describe("singleNpmMajor: a value that names one major", () => {
  it("names the major, or null for a range", () => {
    assert.equal(singleNpmMajor("20"), "20");
    assert.equal(singleNpmMajor("v20.11.1"), "20");
    assert.equal(singleNpmMajor("^20.1.0"), "20");
    assert.equal(singleNpmMajor("20.x"), "20");
    assert.equal(singleNpmMajor(">=20.0.0"), null);
    assert.equal(singleNpmMajor("^18 || ^20"), null);
  });
});
