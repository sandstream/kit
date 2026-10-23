import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBump, decideVerdict, extractNoteHits } from "./upstream-compare.js";
import type { ReleaseInfo } from "./upstream-sources.js";

function release(
  version: string | null,
  body: string,
  extra: Partial<ReleaseInfo> = {},
): ReleaseInfo {
  return {
    tag: version ? `v${version}` : "nightly",
    version,
    name: version ?? "nightly",
    body,
    url: `https://example.test/${version}`,
    prerelease: false,
    publishedAt: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

describe("classifyBump", () => {
  it("names how far behind the installed version is", () => {
    assert.equal(classifyBump("1.45.0", "1.46.0"), "minor");
    assert.equal(classifyBump("1.45.0", "1.45.3"), "patch");
    assert.equal(classifyBump("1.45.0", "2.0.0"), "major");
    assert.equal(classifyBump("1.46.0", "1.46.0"), "none");
  });

  it("reports none when the installed version is ahead of latest", () => {
    assert.equal(classifyBump("2.0.0", "1.9.0"), "none");
  });

  it("is unknown when either side is missing or malformed", () => {
    assert.equal(classifyBump(null, "1.0.0"), "unknown");
    assert.equal(classifyBump("1.0.0", null), "unknown");
    assert.equal(classifyBump("banana", "1.0.0"), "unknown");
  });
});

describe("extractNoteHits", () => {
  const releases = [
    release("1.46.0", "## Changes\n- Deprecated the `foo` option\n- Faster builds"),
    release(
      "1.45.5",
      "Removed support for Node 16\nBREAKING: config key renamed\nMigration guide: see docs",
    ),
    release("1.45.0", "- Deprecated bar (already installed, must not count)"),
    release("1.47.0-rc.1", "- Deprecated baz", { prerelease: true }),
    release(null, "- Deprecated nightly thing"),
  ];

  it("keeps lines with the four keywords from releases newer than the installed version", () => {
    const hits = extractNoteHits(releases, "1.45.0");
    assert.deepEqual(
      hits.map((h) => [h.tag, h.keyword]),
      [
        ["v1.46.0", "deprecat"],
        ["v1.45.5", "removed"],
        ["v1.45.5", "breaking"],
        ["v1.45.5", "migrat"],
      ],
    );
    assert.equal(hits[0].line, "- Deprecated the `foo` option");
    assert.equal(hits[0].url, "https://example.test/1.46.0");
  });

  it("skips prereleases, untagged releases and the installed release itself", () => {
    const hits = extractNoteHits(releases, "1.45.0");
    assert.ok(hits.every((h) => !/baz|nightly|bar/.test(h.line)));
  });

  it("considers every non-prerelease version when the installed version is unknown", () => {
    const hits = extractNoteHits(releases, null);
    assert.ok(hits.some((h) => h.tag === "v1.45.0"));
  });

  it("cuts a very long line and caps the hits per release", () => {
    const body = Array.from(
      { length: 20 },
      (_, i) => `- deprecated item ${i} ${"x".repeat(400)}`,
    ).join("\n");
    const hits = extractNoteHits([release("2.0.0", body)], "1.0.0");
    assert.equal(hits.length, 5);
    assert.ok(hits.every((h) => h.line.length <= 200));
  });

  it("matches case-insensitively and finds nothing in plain notes", () => {
    assert.equal(extractNoteHits([release("2.0.0", "DEPRECATED thing")], "1.0.0").length, 1);
    assert.equal(extractNoteHits([release("2.0.0", "Bug fixes")], "1.0.0").length, 0);
  });
});

describe("decideVerdict", () => {
  const hit = (keyword: "deprecat" | "removed" | "breaking" | "migrat") => ({
    tag: "v2",
    url: "u",
    line: "l",
    keyword,
  });

  it("is skipped when the lookup was skipped, whatever else is known", () => {
    assert.equal(decideVerdict({ lookup: "skipped", bump: "major", hits: [] }), "skipped");
  });

  it("is unknown, never current, when the latest version could not be fetched", () => {
    assert.equal(decideVerdict({ lookup: "unknown", bump: "unknown", hits: [] }), "unknown");
    assert.equal(decideVerdict({ lookup: "ok", bump: "unknown", hits: [] }), "unknown");
  });

  it("is current only when the bump is none", () => {
    assert.equal(decideVerdict({ lookup: "ok", bump: "none", hits: [hit("deprecat")] }), "current");
  });

  it("asks for a read of the notes on a major", () => {
    assert.equal(decideVerdict({ lookup: "ok", bump: "major", hits: [] }), "major, read notes");
  });

  it("recommends the upgrade when a newer release deprecates something", () => {
    assert.equal(
      decideVerdict({ lookup: "ok", bump: "minor", hits: [hit("deprecat")] }),
      "upgrade recommended (deprecation)",
    );
  });

  it("flags breaking, removed and migration notes on a minor as read notes", () => {
    for (const k of ["breaking", "removed", "migrat"] as const) {
      assert.equal(
        decideVerdict({ lookup: "ok", bump: "patch", hits: [hit(k)] }),
        "upgrade available, read notes",
      );
    }
  });

  it("is plain upgrade available with no keyword hits", () => {
    assert.equal(decideVerdict({ lookup: "ok", bump: "minor", hits: [] }), "upgrade available");
  });
});
