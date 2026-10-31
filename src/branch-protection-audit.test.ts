import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditRemoteBranchProtection,
  parseGitRemote,
  runBranchProtectionAudit,
} from "./branch-protection-audit.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("branch protection audit", () => {
  it("parses supported git remotes without accepting arbitrary hosts", () => {
    assert.deepEqual(parseGitRemote("git@github.com:owner/repo.git"), {
      host: "github.com",
      path: "owner/repo",
    });
    assert.deepEqual(parseGitRemote("https://gitlab.com/group/sub/repo.git"), {
      host: "gitlab.com",
      path: "group/sub/repo",
    });
    assert.equal(parseGitRemote("https://example.com/owner/repo.git"), null);
  });

  it("reports missing token as unverified without calling the API", async () => {
    let called = false;
    const row = await auditRemoteBranchProtection(
      "git@github.com:owner/repo.git",
      null,
      async () => {
        called = true;
        throw new Error("unexpected call");
      },
    );
    assert.equal(row.status, "warn");
    assert.equal(row.didNotRun, true);
    assert.equal(called, false);
  });

  it("reads GitHub default branch and its protection flag", async () => {
    const urls: string[] = [];
    const row = await auditRemoteBranchProtection(
      "git@github.com:owner/repo.git",
      "fake-token",
      async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify(urls.length === 1 ? { default_branch: "main" } : { protected: true }),
          { status: 200 },
        );
      },
    );
    assert.equal(row.status, "pass");
    assert.deepEqual(urls, [
      "https://api.github.com/repos/owner/repo",
      "https://api.github.com/repos/owner/repo/branches/main",
    ]);
  });

  it("reports an unprotected GitLab default branch", async () => {
    const row = await auditRemoteBranchProtection(
      "https://gitlab.com/group/repo.git",
      "fake-token",
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/repository/branches/main")
              ? { protected: false }
              : { default_branch: "main" },
          ),
          { status: 200 },
        ),
    );
    assert.equal(row.status, "warn");
    assert.match(row.detail, /unprotected/);
  });
});

describe("branch protection failures and project config", () => {
  it("treats API errors and malformed responses as unverified", async () => {
    for (const response of [
      new Response("{}", { status: 403 }),
      new Response("{}", { status: 200 }),
    ]) {
      const row = await auditRemoteBranchProtection(
        "git@github.com:owner/repo.git",
        "fake-token",
        async () => response,
      );
      assert.equal(row.status, "warn");
      assert.equal(row.didNotRun, true);
    }
  });
  it("reads the declared kit secret and the git origin without exposing the token", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-branch-audit-"));
    const oldToken = process.env.GITHUB_TOKEN;
    const oldAirgap = process.env.KIT_AIRGAP;
    const oldFetch = globalThis.fetch;
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:owner/repo.git"]);
      writeFileSync(join(root, ".kit.toml"), '[secrets.keys.GITHUB_TOKEN]\nsource = "env"\n');
      process.env.GITHUB_TOKEN = "private-test-token";
      let calls = 0;
      globalThis.fetch = async (_url, options) => {
        calls++;
        assert.equal(
          (options?.headers as Record<string, string>).Authorization,
          "Bearer private-test-token",
        );
        return new Response(
          JSON.stringify(calls === 1 ? { default_branch: "main" } : { protected: true }),
          { status: 200 },
        );
      };
      const [row] = await runBranchProtectionAudit(root);
      assert.equal(row.status, "pass");
      assert.equal(calls, 2);
      assert.doesNotMatch(JSON.stringify(row), /private-test-token/);
      process.env.KIT_AIRGAP = "1";
      const [offline] = await runBranchProtectionAudit(root);
      assert.equal(offline.status, "skip");
      assert.equal(offline.didNotRun, true);
      assert.equal(calls, 2);
    } finally {
      if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldToken;
      if (oldAirgap === undefined) delete process.env.KIT_AIRGAP;
      else process.env.KIT_AIRGAP = oldAirgap;
      globalThis.fetch = oldFetch;
      rmTemp(root);
    }
  });
});
