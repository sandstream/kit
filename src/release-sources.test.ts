import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checksumUrls, hashesFor, publishedChecksums } from "./release-sources.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("release checksum sources", () => {
  it("reads GNU, BSD and per-asset forms, by exact name or last path component", () => {
    assert.deepEqual(hashesFor(`${A}  tool.tgz\n${B}  other\n`, "tool.tgz"), [A]);
    assert.deepEqual(hashesFor(`${A} *./dist/tool.tgz\n`, "tool.tgz"), [A]);
    assert.deepEqual(hashesFor(`SHA256 (tool.tgz) = ${A.toUpperCase()}\n`, "tool.tgz"), [A]);
    assert.deepEqual(
      hashesFor(`${A}\n`, "tool.tgz"),
      [],
      "a lone hash only in the asset's own file",
    );
    assert.deepEqual(hashesFor(`${A}\n`, "tool.tgz", true), [A]);
    assert.deepEqual(hashesFor(`${A}  linux/tool.tgz\n${B}  mac/tool.tgz\n`, "tool.tgz"), [A, B]);
  });

  it("takes the release's own checksum assets, else guesses next to the URL", async () => {
    const assets = ["tool.tgz", "tool.tgz.sha256", "checksums.txt", "notes.txt"].map((name) => ({
      name,
      url: `https://h.example/${name}`,
      digest: null,
    }));
    const release = {
      tag: "v1",
      publishedAt: null,
      draft: false,
      prerelease: false,
      servedFrom: null,
      assets,
    };
    assert.deepEqual(checksumUrls("https://h.example/tool.tgz", "tool.tgz", release), [
      "https://h.example/tool.tgz.sha256",
      "https://h.example/checksums.txt",
    ]);
    const guesses = checksumUrls("https://h.example/v1/tool.tgz", "tool.tgz", null);
    assert.equal(guesses.length, 3);
    const texts: Record<string, string> = { [guesses[0]!]: `${A}\n`, [guesses[1]!]: "unrelated\n" };
    const found = await publishedChecksums(guesses, "tool.tgz", {
      fetchText: async (u) => texts[u] ?? null,
      getJson: async () => null,
    });
    assert.deepEqual(
      found.map((f) => [f.source, f.hashes]),
      [[guesses[0], [A]]],
    );
  });
});
