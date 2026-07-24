import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root: this compiled test lives at dist/changelog-section.test.js, so the
// repo root is one directory up from dist/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "changelog-section.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

// The publish job's step order is load-bearing: the CHANGELOG check only
// protects anything if it runs BEFORE `npm publish`. It originally sat after
// it, so a missing section was caught once the version was already burned on
// npm — published, no release, red job. Pin the order here so that cannot
// silently come back.
describe("publish workflow ordering", () => {
  const wf = readFileSync(join(REPO_ROOT, ".github", "workflows", "publish.yml"), "utf8");
  const stepIndex = (name: string) => wf.indexOf(`- name: ${name}`);

  it("validates the CHANGELOG before publishing to npm", () => {
    const check = stepIndex("Verify the CHANGELOG documents this version");
    const publish = stepIndex("Publish to npm with provenance");
    assert.ok(check !== -1, "the CHANGELOG verification step is missing from publish.yml");
    assert.ok(publish !== -1, "the npm publish step is missing from publish.yml");
    assert.ok(
      check < publish,
      "the CHANGELOG check must precede `npm publish` — otherwise a missing section " +
        "is only caught after the version is already published and unrecoverable",
    );
  });

  it("creates the GitHub release before the SBOM steps that attach to it", () => {
    const release = stepIndex("Create GitHub release");
    const sbom = stepIndex("Generate SBOM (CycloneDX)");
    const attach = stepIndex("Attach SBOMs to GitHub release");
    assert.ok(release !== -1 && sbom !== -1 && attach !== -1);
    assert.ok(release < sbom, "the release must exist before sbom-action tries to attach to it");
    assert.ok(sbom < attach, "SBOMs must be generated before they are attached");
  });

  it("does not swallow failures on the SBOM attach step", () => {
    // A `|| true` here is what let the SBOMs silently reach no release at all
    // for every version through 5.10.0.
    const attach = stepIndex("Attach SBOMs to GitHub release");
    const next = wf.indexOf("      - name:", attach + 10);
    const body = wf.slice(attach, next === -1 ? undefined : next);
    // Comments legitimately mention `|| true` (explaining why it is gone), so
    // only executable lines count.
    const code = body
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.doesNotMatch(
      code,
      /\|\|\s*true/,
      "the SBOM attach step must fail loudly, not `|| true`",
    );
  });
});

describe("changelog-section", () => {
  it("extracts a version's section from the real CHANGELOG", () => {
    const r = run(["5.10.0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ADR gate adoption/);
    // Verification pointers are appended for release readers.
    assert.match(r.stdout, /git tag -v v5\.10\.0/);
    assert.match(r.stdout, /npm audit signatures/);
  });

  it("stops at the next version heading", () => {
    const r = run(["5.9.0"]);
    assert.equal(r.status, 0, r.stderr);
    // 5.8.0 is the next section down; its content must not bleed in.
    assert.doesNotMatch(r.stdout, /^## \[5\.8\.0\]/m);
  });

  it("covers every published version currently in the CHANGELOG", () => {
    const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const versions = [...changelog.matchAll(/^## \[?(\d+\.\d+\.\d+)\]?/gm)].map((m) => m[1]);
    assert.ok(versions.length > 0, "no versions parsed out of CHANGELOG.md");
    for (const v of versions) {
      const r = run([v]);
      assert.equal(r.status, 0, `${v}: ${r.stderr}`);
      assert.ok(r.stdout.trim().length > 0, `${v}: empty notes`);
    }
  });

  it("fails loudly on an unknown version rather than emitting empty notes", () => {
    const r = run(["99.99.99"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no CHANGELOG section found/);
    assert.equal(r.stdout, "");
  });

  it("exits 2 without a version argument", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });

  it("keeps the package version releasable — its section must exist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const r = run([pkg.version]);
    assert.equal(
      r.status,
      0,
      `package.json is ${pkg.version} but CHANGELOG.md has no section for it — ` +
        `the publish workflow would fail at the release step`,
    );
  });
});
