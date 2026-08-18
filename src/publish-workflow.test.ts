import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * publish.yml ↔ npm's trusted-publishing prerequisites.
 *
 * npm is retiring 2FA-bypass granular access tokens as a publishing credential:
 * from ~January 2027 such a token can only read private packages and STAGE a
 * publish for human 2FA approval. The migration target is trusted publishing —
 * an OIDC exchange with no long-lived secret at all — and it exists only in
 * **npm >= 11.5.1 on node >= 22.14.0**.
 *
 * `actions/setup-node` with `node-version: "22"` ships npm 10.9.x, so the client
 * in this job has no OIDC exchange to make. That is a prerequisite the repo can
 * assert about itself today, before the registry-side switch (which is 13
 * per-package configurations on npmjs.com — see docs/RELEASING.md), so the
 * migration cannot arrive to find the runner too old.
 *
 * The gate is here rather than in prose because a comment cannot fail CI, and a
 * publish job only ever runs on a tag push — the worst possible moment to learn
 * that its npm is too old.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(REPO_ROOT, ".github/workflows/publish.yml"), "utf-8");

/** The workflow with its comment lines removed. Every assertion below is about what the job
 *  RUNS, and this file is heavily commented — a comment that merely mentions `npm publish`
 *  must not be mistaken for the step that performs it. */
const EXECUTED = WORKFLOW.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** npm's documented floor for trusted publishing. */
const MIN_NPM = [11, 5, 1] as const;

function atLeast(found: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const f = found[i] ?? 0;
    if (f > min[i]) return true;
    if (f < min[i]) return false;
  }
  return true;
}

describe("publish.yml — trusted-publishing prerequisites", () => {
  it("installs an npm that has the OIDC exchange (>= 11.5.1)", () => {
    const m = EXECUTED.match(/npm (?:i|install) -g npm@\^?(\d+)\.(\d+)\.(\d+)/);
    assert.ok(
      m,
      "publish.yml must install npm explicitly: setup-node's bundled npm for node 22 is 10.9.x, which predates trusted publishing (>= 11.5.1)",
    );
    const found = [Number(m[1]), Number(m[2]), Number(m[3])];
    assert.ok(
      atLeast(found, MIN_NPM),
      `publish.yml pins npm ${found.join(".")}, below trusted publishing's floor ${MIN_NPM.join(".")}`,
    );
  });

  it("upgrades npm BEFORE the first publish", () => {
    const upgrade = EXECUTED.search(/npm (?:i|install) -g npm@/);
    const publish = EXECUTED.indexOf("npm publish");
    assert.ok(publish > 0, "publish.yml no longer runs `npm publish`");
    assert.ok(
      upgrade > 0 && upgrade < publish,
      "the npm upgrade must run before any publish step, or the publish uses the old client",
    );
  });

  it("asks for a node that admits that npm (>= 22.14.0)", () => {
    const m = EXECUTED.match(/node-version:\s*"?(\d+)(?:\.(\d+))?(?:\.(\d+))?"?/);
    assert.ok(m, "publish.yml must declare a node-version");
    const major = Number(m[1]);
    // A bare major ("22") resolves to the latest 22.x, which is >= 22.14. A pinned
    // minor must clear 22.14 itself.
    if (m[2] === undefined) {
      assert.ok(major >= 22, `node-version ${major} predates trusted publishing's node floor`);
      return;
    }
    assert.ok(
      atLeast([major, Number(m[2]), Number(m[3] ?? 0)], [22, 14, 0]),
      `node-version ${m[0]} is below node 22.14.0`,
    );
  });
});
