import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitRemote } from "./remote.js";

describe("parseGitRemote", () => {
  it("parses an SSH remote", () => {
    assert.deepEqual(parseGitRemote("git@gitlab.com:acme/web.git"), {
      host: "gitlab.com",
      path: "acme/web",
    });
  });

  it("parses an HTTPS remote and strips .git", () => {
    assert.deepEqual(parseGitRemote("https://bitbucket.org/acme/web.git"), {
      host: "bitbucket.org",
      path: "acme/web",
    });
  });

  it("keeps GitLab nested subgroups", () => {
    assert.deepEqual(parseGitRemote("git@gitlab.com:acme/team/web.git"), {
      host: "gitlab.com",
      path: "acme/team/web",
    });
  });

  it("strips an embedded HTTPS user", () => {
    assert.deepEqual(parseGitRemote("https://x-token-auth@bitbucket.org/acme/web"), {
      host: "bitbucket.org",
      path: "acme/web",
    });
  });

  it("returns null for junk", () => {
    assert.equal(parseGitRemote(""), null);
    assert.equal(parseGitRemote("not a url"), null);
  });
});
