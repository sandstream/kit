/**
 * Identity is now asserted, not merely printed.
 *
 * `kit check` reported `✓ vercel authenticated <account>` and compared it to nothing, while
 * `kit context check` asserted only ids from repo-local files. The gap cost real work: a session
 * whose CLI was logged in as a personal account with read-only rights on the production
 * environment read a FILTERED variable list as a complete one — `env ls` showed four variables
 * and looked whole, `env pull --environment=production` failed as if the variable did not exist,
 * and two contradictory conclusions were drawn before a web UI settled it (#503).
 *
 * The tests below pin the three properties that make the fix worth having: a declared identity
 * that differs is a MISMATCH (red, non-zero), an identity that cannot be read is UNKNOWN rather
 * than a mismatch ("cannot tell" ≠ "wrong account"), and a mismatch tells you the per-tool
 * mechanism that scopes an identity to a repo — because "log in again" is what created the
 * problem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareContext,
  identityRemediation,
  normaliseIdentity,
  readConvexAccount,
  suggestContextToml,
  type LiveContext,
} from "./context-lock.js";

describe("identity assertion", () => {
  it("a declared identity that differs is a mismatch, not a note", () => {
    const findings = compareContext(
      { vercel: { user: "deploy-bot" }, github: { user: "octocat" } },
      {
        vercel: { orgId: null, projectId: null, user: "someones-personal-account" },
        github: { org: null, remote: null, user: "octocat" },
      } as LiveContext,
    );
    const vercel = findings.find((f) => f.tool === "vercel" && f.field === "user");
    const github = findings.find((f) => f.tool === "github" && f.field === "user");
    assert.equal(vercel?.status, "mismatch");
    assert.equal(vercel?.expected, "deploy-bot");
    assert.equal(vercel?.actual, "someones-personal-account");
    assert.equal(github?.status, "ok");
  });

  it("an unreadable identity is unknown — cannot tell is not wrong account", () => {
    const findings = compareContext({ vercel: { user: "deploy-bot" } }, {
      vercel: { orgId: null, projectId: null, user: null },
    } as LiveContext);
    const f = findings.find((x) => x.tool === "vercel" && x.field === "user");
    assert.equal(f?.status, "unknown");
    assert.equal(f?.actual, null);
  });

  it("an undeclared identity is not checked at all", () => {
    const findings = compareContext({ vercel: { team: "team_x" } }, {
      vercel: { orgId: "team_x", projectId: null, user: "whoever" },
    } as LiveContext);
    assert.equal(
      findings.some((f) => f.field === "user"),
      false,
      "nothing declared, nothing asserted",
    );
  });

  it("convex is checked as an account, since it has no profiles to scope", () => {
    const findings = compareContext({ convex: { account: "ops@example.test" } }, {
      convex: { account: "someone-else@example.test" },
    } as LiveContext);
    const f = findings.find((x) => x.tool === "convex");
    assert.equal(f?.status, "mismatch");
  });
});

describe("normaliseIdentity", () => {
  it("takes the answer, not the CLI's chatter", () => {
    assert.equal(normaliseIdentity("Retrieving scope…\nacme-team\n"), "acme-team");
    assert.equal(normaliseIdentity("  octocat  "), "octocat");
  });

  it("returns null for no answer, an error, or a not-authenticated notice", () => {
    assert.equal(normaliseIdentity(null), null);
    assert.equal(normaliseIdentity(""), null);
    assert.equal(normaliseIdentity("Error: not authenticated"), null);
    assert.equal(normaliseIdentity("You are not authenticated. Run login."), null);
  });

  it("refuses an implausibly long line rather than reporting a paragraph as an identity", () => {
    assert.equal(normaliseIdentity("x".repeat(300)), null);
  });
});

describe("readConvexAccount", () => {
  let home = "";
  const withConfig = (body: unknown): string => {
    home = mkdtempSync(join(tmpdir(), "kit-convex-"));
    mkdirSync(join(home, ".convex"), { recursive: true });
    writeFileSync(join(home, ".convex", "config.json"), JSON.stringify(body));
    return home;
  };

  it("reads the identity out of the global config", () => {
    const h = withConfig({ email: "ops@example.test" });
    try {
      assert.equal(readConvexAccount(h), "ops@example.test");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("says logged-in-but-unreadable rather than nothing when only a token is present", () => {
    const h = withConfig({ accessToken: "secret" });
    try {
      const got = readConvexAccount(h);
      assert.match(String(got), /logged in/);
      assert.doesNotMatch(String(got), /secret/, "never echo the token");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("returns null when there is no config to read", () => {
    const h = mkdtempSync(join(tmpdir(), "kit-convex-empty-"));
    try {
      assert.equal(readConvexAccount(h), null);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("identityRemediation", () => {
  it("names the per-tool mechanism, never 'log in again'", () => {
    assert.match(String(identityRemediation("vercel")), /-Q|VERCEL_TOKEN/);
    assert.match(String(identityRemediation("github")), /gh auth switch/);
    assert.match(String(identityRemediation("gcloud")), /configurations activate/);
    for (const tool of ["vercel", "github", "gcloud", "aws", "stripe"]) {
      assert.doesNotMatch(
        String(identityRemediation(tool)),
        /^log in again/i,
        `${tool}: a global login is what produced the wrong identity`,
      );
    }
  });

  it("says outright that convex has no profiles, instead of inventing one", () => {
    const hint = String(identityRemediation("convex"));
    assert.match(hint, /NO profiles/);
    assert.match(hint, /CONVEX_DEPLOY_KEY/);
  });

  it("has nothing to say about a tool with no mechanism", () => {
    assert.equal(identityRemediation("jq"), null);
  });
});

describe("suggestContextToml", () => {
  it("offers the identities it detected, hedged — they are what the lock questions", () => {
    const out = suggestContextToml({
      github: { org: "acme", remote: "github.com/acme/x", user: "octocat" },
      vercel: { orgId: "team_1", projectId: "prj_1", user: "octocat" },
    } as LiveContext);
    assert.match(out, /user = "octocat"/);
    assert.match(out, /VERIFY it is right for THIS repo/);
  });

  it("does not offer a parenthetical note as a value to declare", () => {
    const out = suggestContextToml({
      convex: { account: "(logged in, identity not in config)" },
    } as LiveContext);
    assert.doesNotMatch(out, /logged in, identity not in config/);
    assert.doesNotMatch(out, /\[context\.convex\]/);
  });
});
