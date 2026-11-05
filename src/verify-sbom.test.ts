import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error plain .mjs script, no type declarations
import { componentNames, judgeSbom, MIN_COMPONENTS } from "../scripts/verify-sbom.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `dep-${i}` }));

describe("verify-sbom", () => {
  it("fails the root-only SBOM that 7.2.0 shipped", () => {
    const rootOnly = {
      bomFormat: "CycloneDX",
      metadata: { component: { name: "sandstream-kit" } },
    };
    const found = judgeSbom("sbom.cyclonedx.json", rootOnly, "sandstream-kit");
    assert.equal(found.length, 1);
    assert.match(found[0], /lists 0 dependencies/);
  });

  it("fails an SPDX file whose only package is the root", () => {
    const doc = { spdxVersion: "SPDX-2.3", packages: [{ name: "sandstream-kit" }] };
    assert.equal(judgeSbom("sbom.spdx.json", doc, "sandstream-kit").length, 1);
  });

  it("passes a CycloneDX file with the dependencies listed", () => {
    const doc = { components: [{ name: "sandstream-kit" }, ...many(MIN_COMPONENTS)] };
    assert.deepEqual(judgeSbom("sbom.cyclonedx.json", doc, "sandstream-kit"), []);
  });

  it("does not count the root toward the minimum", () => {
    const doc = { components: [{ name: "sandstream-kit" }, ...many(MIN_COMPONENTS - 1)] };
    assert.equal(judgeSbom("sbom.cyclonedx.json", doc, "sandstream-kit").length, 1);
  });

  it("rejects a document in neither format", () => {
    assert.equal(componentNames({ hello: "world" }), null);
    assert.match(judgeSbom("x.json", {}, "sandstream-kit")[0], /not a CycloneDX or SPDX/);
  });
});

describe("publish workflow SBOM scan", () => {
  const wf = readFileSync(join(REPO_ROOT, ".github", "workflows", "publish.yml"), "utf8");

  it("scans an installed tree, not the bare unpacked tarball", () => {
    assert.match(wf, /npm i[a-z]* .*--omit=dev --ignore-scripts/);
    assert.doesNotMatch(wf, /path: \.release-package\/package/);
  });

  it("checks the SBOMs before it attaches them to the release", () => {
    const check = wf.indexOf("scripts/verify-sbom.mjs");
    const attach = wf.indexOf("Attach SBOMs to GitHub release");
    assert.ok(check > 0, "the workflow runs verify-sbom.mjs");
    assert.ok(check < attach, "the check comes before the upload");
  });
});
