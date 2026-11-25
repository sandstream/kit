import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error plain .mjs script, no type declarations
import { componentNames, judgeSbom, runtimeDependencies } from "../scripts/verify-sbom.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEPS = ["zod", "smol-toml"];

describe("verify-sbom", () => {
  it("fails the root-only SBOM that 7.2.0 shipped", () => {
    const rootOnly = {
      bomFormat: "CycloneDX",
      metadata: { component: { name: "sandstream-kit" } },
    };
    const found = judgeSbom("sbom.cyclonedx.json", rootOnly, "sandstream-kit", DEPS);
    assert.equal(found.length, 1);
    assert.match(found[0], /does not list zod, smol-toml, runtime dependencies/);
  });

  it("fails an SPDX file whose only package is the root", () => {
    const doc = { spdxVersion: "SPDX-2.3", packages: [{ name: "sandstream-kit" }] };
    assert.equal(judgeSbom("sbom.spdx.json", doc, "sandstream-kit", DEPS).length, 1);
  });

  it("passes a small but complete SBOM: two runtime dependencies are enough (7.6.0)", () => {
    const doc = { components: [{ name: "sandstream-kit" }, { name: "zod" }, { name: "smol-toml" }] };
    assert.deepEqual(judgeSbom("sbom.cyclonedx.json", doc, "sandstream-kit", DEPS), []);
  });

  it("names the runtime dependency the SBOM leaves out", () => {
    const doc = { packages: [{ name: "sandstream-kit" }, { name: "zod" }, { name: "other" }] };
    const found = judgeSbom("sbom.spdx.json", doc, "sandstream-kit", DEPS);
    assert.deepEqual(found, ["sbom.spdx.json: does not list smol-toml, a runtime dependency"]);
  });

  it("rejects a package with no runtime dependencies to check against", () => {
    const doc = { components: [{ name: "sandstream-kit" }] };
    assert.match(judgeSbom("x.json", doc, "sandstream-kit", [])[0], /no runtime dependencies/);
  });

  it("reads the runtime dependencies from this repository's package.json", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    assert.deepEqual(runtimeDependencies(pkg), Object.keys(pkg.dependencies));
    assert.ok(runtimeDependencies(pkg).length > 0);
  });

  it("rejects a document in neither format", () => {
    assert.equal(componentNames({ hello: "world" }), null);
    assert.match(judgeSbom("x.json", {}, "sandstream-kit", DEPS)[0], /not a CycloneDX or SPDX/);
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
