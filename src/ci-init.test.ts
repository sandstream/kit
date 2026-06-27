import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pipelineSnippet, isCiHost, CI_HOSTS } from "./ci-init.js";
import { auditCiYaml } from "./ci-audit.js";

describe("ci-init pipeline snippets", () => {
  it("isCiHost accepts gitlab/bitbucket, rejects others", () => {
    assert.ok(isCiHost("gitlab"));
    assert.ok(isCiHost("bitbucket"));
    assert.ok(!isCiHost("github"));
    assert.ok(!isCiHost("jenkins"));
    assert.deepEqual([...CI_HOSTS], ["gitlab", "bitbucket"]);
  });

  it("gitlab snippet targets .gitlab-ci.yml and runs kit ci with a JUnit artifact", () => {
    const s = pipelineSnippet("gitlab");
    assert.equal(s.file, ".gitlab-ci.yml");
    assert.match(s.content, /sandstream-kit ci --format gitlab/);
    assert.match(s.content, /junit: kit-report\.xml/);
  });

  it("bitbucket snippet targets bitbucket-pipelines.yml and runs kit ci", () => {
    const s = pipelineSnippet("bitbucket");
    assert.equal(s.file, "bitbucket-pipelines.yml");
    assert.match(s.content, /sandstream-kit ci/);
  });

  // Dogfood: the snippets kit emits must pass kit's own ci-audit (pinned image,
  // no remote include, no pipe-to-shell).
  for (const host of CI_HOSTS) {
    it(`${host} snippet is clean under kit's own ci-audit`, () => {
      const s = pipelineSnippet(host);
      const findings = auditCiYaml(s.content, s.file).filter((f) => f.status !== "pass");
      assert.deepEqual(
        findings,
        [],
        `expected no ci-audit findings, got ${findings.map((f) => f.name)}`,
      );
    });
  }
});
