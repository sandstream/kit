import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalReleaseUrl, githubReleaseAsset, urlFileName } from "./release-url.js";

describe("release URLs", () => {
  it("spells a URL one way for receipts, and refuses non-http or credentialed ones", () => {
    assert.equal(canonicalReleaseUrl("HTTPS://H.Example/a/b.tgz#x"), "https://h.example/a/b.tgz");
    assert.equal(canonicalReleaseUrl("ftp://h.example/a"), null);
    assert.equal(canonicalReleaseUrl("https://u:p@h.example/a"), null);
    assert.equal(canonicalReleaseUrl("not a url"), null);
  });

  it("splits a GitHub release asset URL, and marks a latest/download URL as having no tag", () => {
    const base = "https://github.com/acme/tool/releases";
    assert.deepEqual(githubReleaseAsset(`${base}/download/v1.2.3/tool.tgz`), {
      owner: "acme",
      repo: "tool",
      tag: "v1.2.3",
      asset: "tool.tgz",
    });
    assert.equal(githubReleaseAsset(`${base}/latest/download/tool.tgz`)?.tag, null);
    assert.equal(githubReleaseAsset("https://h.example/acme/tool/releases/download/v1/x"), null);
    assert.equal(githubReleaseAsset(`${base}/tag/v1`), null);
    assert.equal(urlFileName("https://h.example/a/tool%2Bx.tgz?y=1"), "tool%2Bx.tgz");
  });
});
