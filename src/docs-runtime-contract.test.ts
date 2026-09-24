import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("runtime claims in documentation", () => {
  it("describes update checks and opt-in auto-update without a no-phone-home claim", () => {
    const verify = read("docs/VERIFY.md");
    assert.match(verify, /cached version\s+check against the npm registry/);
    assert.match(verify, /\[update\]\.auto = true/);
    assert.doesNotMatch(verify, /No phone-home version-check/);
  });

  it("documents air-gap download suppression and local Semgrep rules", () => {
    const airGap = read("docs/AIR_GAP.md");
    assert.match(airGap, /prevents\s+Bumblebee binary downloads/);
    assert.match(airGap, /explicit\s+local ruleset path can run offline/);
    assert.doesNotMatch(airGap, /Nothing else phones home/);
    assert.doesNotMatch(airGap, /make no network calls regardless/);
  });

  it("keeps supply-chain findings separate from the chained audit log", () => {
    const readme = read("README.md");
    assert.match(readme, /findings auto-append to `\.kit-findings\.jsonl`/);
    assert.doesNotMatch(readme, /findings auto-append to `\.kit-audit\.jsonl`/);
  });

  it("documents the reachable remote-audit config keys", () => {
    for (const path of ["docs/DATA_FLOW.md", "docs/THREAT_MODEL.md"]) {
      const doc = read(path);
      assert.match(doc, /\[governance\.audit\]\.remote/);
      assert.match(doc, /\[governance\.audit\]\.company_id/);
    }
  });

  it("ships the Monkey Test manual linked from the package README", () => {
    const manifest = JSON.parse(read("package.json")) as { files?: string[] };
    const readme = read("README.md");

    assert.match(readme, /\[docs\/MONKEY_TEST\.md\]\(docs\/MONKEY_TEST\.md\)/);
    assert.ok(manifest.files?.includes("docs/MONKEY_TEST.md"));
  });
});
