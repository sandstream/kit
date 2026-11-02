import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAllow, parseScanAllow, type AllowEntry } from "./scan-allow.js";
import type { StagedHit } from "./scan-staged.js";

const good = {
  path: ".gitlab-ci.yml",
  match: "keyed-secret",
  reason: "CI cache key, not a cryptographic key",
  reviewed: "2026-11-01",
};

function problems(raw: unknown): string[] {
  return parseScanAllow(raw).problems.map((p) => p.message);
}

describe("parseScanAllow", () => {
  it("accepts a narrow entry with a reason", () => {
    const { entries, problems: bad } = parseScanAllow([good]);
    assert.deepEqual(bad, []);
    assert.equal(entries[0]?.path, ".gitlab-ci.yml");
  });

  it("treats a missing setting as no allowlist", () => {
    assert.deepEqual(parseScanAllow(undefined), { entries: [], problems: [] });
  });

  it("rejects an entry without a reason and names the fix", () => {
    const [message] = problems([{ ...good, reason: undefined }]);
    assert.match(message ?? "", /entry 1/);
    assert.match(message ?? "", /reason/);
    assert.match(message ?? "", /why this match is harmless/);
  });

  it("rejects a reason that is only blank space", () => {
    assert.equal(problems([{ ...good, reason: "   " }]).length, 1);
  });

  it("refuses a directory, a glob and a path that leaves the repo", () => {
    for (const path of ["src/", "src/**/*.ts", "*.yml", ".", "../outside", "/etc/passwd"]) {
      assert.equal(problems([{ ...good, path }]).length, 1, path);
    }
  });

  it("refuses a pattern in place of a label", () => {
    for (const match of [".*", "*", "keyed-.*", ""]) {
      assert.equal(problems([{ ...good, match }]).length, 1, match);
    }
  });

  it("never allows the fail-closed unscannable finding", () => {
    const message = problems([{ ...good, match: "unscannable staged blob (fail-closed)" }]);
    assert.equal(message.length, 1);
    assert.match(message[0] ?? "", /cannot be allowed/);
  });

  it("rejects an unknown setting, so a typo does not silently drop the reason", () => {
    assert.match(problems([{ ...good, reson: "typo" }])[0] ?? "", /unknown setting "reson"/);
  });

  it("rejects a reviewed date that is not YYYY-MM-DD", () => {
    assert.equal(problems([{ ...good, reviewed: "yesterday" }]).length, 1);
  });

  it("rejects an allowlist that is not a list", () => {
    assert.equal(problems({ path: "a" }).length, 1);
  });

  it("keeps the valid entries and reports the broken ones by number", () => {
    const parsed = parseScanAllow([good, { ...good, reason: "" }]);
    assert.equal(parsed.entries.length, 1);
    assert.match(parsed.problems[0]?.message ?? "", /entry 2/);
  });
});

const entry: AllowEntry = {
  path: ".gitlab-ci.yml",
  match: "keyed-secret",
  reason: "CI cache key, not a cryptographic key",
};
const finding = (label: string, preview = 'key: "maven-…"') => ({ label, preview });
const hit = (file: string, ...findings: ReturnType<typeof finding>[]): StagedHit => ({
  file,
  findings,
});
const present = () => true;

describe("applyAllow", () => {
  it("lets a covered finding through and names the entry", () => {
    const out = applyAllow([hit(".gitlab-ci.yml", finding("keyed-secret"))], [entry], [], present);
    assert.deepEqual(out.hits, []);
    assert.equal(out.used[0]?.entry, entry);
    assert.equal(out.used[0]?.count, 1);
  });

  it("still blocks a finding the entry does not cover", () => {
    const hits = [
      hit(".gitlab-ci.yml", finding("keyed-secret"), finding("private-key")),
      hit("other.yml", finding("keyed-secret")),
    ];
    const out = applyAllow(hits, [entry], [], present);
    assert.deepEqual(
      out.hits.map((h) => [h.file, h.findings.map((f) => f.label)]),
      [
        [".gitlab-ci.yml", ["private-key"]],
        ["other.yml", ["keyed-secret"]],
      ],
    );
  });

  it("narrows to one value when the entry names the preview", () => {
    const narrow = { ...entry, preview: 'key: "maven-…"' };
    const hits = [
      hit(".gitlab-ci.yml", finding("keyed-secret"), finding("keyed-secret", "OTHER…")),
    ];
    const out = applyAllow(hits, [narrow], [], present);
    assert.deepEqual(
      out.hits[0]?.findings.map((f) => f.preview),
      ["OTHER…"],
    );
  });

  it("never lets the unscannable finding through", () => {
    const blob = finding("unscannable staged blob (fail-closed)");
    const loose = { ...entry, match: blob.label };
    const out = applyAllow([hit(".gitlab-ci.yml", blob)], [loose], [], present);
    assert.equal(out.hits.length, 1);
    assert.deepEqual(out.used, []);
  });

  it("reports an entry whose file is staged but no longer matches as stale", () => {
    const out = applyAllow([], [entry], [".gitlab-ci.yml"], present);
    assert.equal(out.stale.length, 1);
    assert.match(out.stale[0]?.why ?? "", /matched nothing/);
  });

  it("reports an entry whose file no longer exists as stale", () => {
    const out = applyAllow([], [entry], [], () => false);
    assert.match(out.stale[0]?.why ?? "", /no longer exists/);
  });

  it("does not call an entry stale when its file is not part of this commit", () => {
    assert.deepEqual(applyAllow([], [entry], ["other.yml"], present).stale, []);
  });

  it("does not call a used entry stale", () => {
    const out = applyAllow([hit(".gitlab-ci.yml", finding("keyed-secret"))], [entry], [], present);
    assert.deepEqual(out.stale, []);
  });
});
