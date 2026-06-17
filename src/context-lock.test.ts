import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareContext, parseGithubRemote, type LiveContext } from "./context-lock.js";

describe("context lock", () => {
  it("passes only when the exact declared pair matches", () => {
    const declared = { gcloud: { account: "ops@example.com", project: "prod-project" } };
    const live: LiveContext = { gcloud: { account: "ops@example.com", project: "prod-project" } };
    const f = compareContext(declared, live);
    assert.equal(f.filter((x) => x.status !== "ok").length, 0);
  });

  it("flags right account + WRONG project as a mismatch (never trust the ambient pair)", () => {
    const declared = { gcloud: { account: "ops@example.com", project: "prod-project" } };
    const live: LiveContext = { gcloud: { account: "ops@example.com", project: "other-project" } };
    const proj = compareContext(declared, live).find(
      (x) => x.tool === "gcloud" && x.field === "project",
    );
    assert.equal(proj?.status, "mismatch");
    assert.equal(proj?.expected, "prod-project");
    assert.equal(proj?.actual, "other-project");
  });

  it("marks unreadable live state as unknown (does not block)", () => {
    const declared = { npm: { registry: "https://registry.npmjs.org" } };
    const live: LiveContext = { npm: { registry: null } };
    assert.equal(compareContext(declared, live)[0]?.status, "unknown");
  });

  it("only checks declared fields", () => {
    const declared = { git: { email: "dev@example.com" } };
    const live: LiveContext = {
      gcloud: { account: "x", project: "y" },
      git: { email: "dev@example.com" },
    };
    const f = compareContext(declared, live);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.tool, "git");
    assert.equal(f[0]?.status, "ok");
  });

  it("flags a vercel link to the wrong project", () => {
    const declared = { vercel: { team: "team_example", project: "prj_canonical" } };
    const live: LiveContext = { vercel: { orgId: "team_example", projectId: "prj_stale" } };
    const proj = compareContext(declared, live).find((x) => x.field === "project(projectId)");
    assert.equal(proj?.status, "mismatch");
  });

  it("parses github org + remote from ssh and https urls", () => {
    assert.deepEqual(parseGithubRemote("git@github.com:example-org/example-repo.git"), {
      org: "example-org",
      remote: "github.com/example-org/example-repo",
    });
    assert.deepEqual(parseGithubRemote("https://github.com/example-org/example-repo"), {
      org: "example-org",
      remote: "github.com/example-org/example-repo",
    });
    assert.deepEqual(parseGithubRemote(null), { org: null, remote: null });
    assert.deepEqual(parseGithubRemote("https://gitlab.com/x/y"), { org: null, remote: null });
  });
});
