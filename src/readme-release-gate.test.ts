/**
 * The README ships inside the npm package and is the package page. Two ways it went stale
 * at once for 6.12.0: npm stores only about 64 KB of it, so a 72 KB README showed cut off
 * mid-sentence, and its "what's new" still led with 5.0. Every version bump must refresh it,
 * so a bump that does not is a CI failure rather than a reminder.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

describe("README is refreshed by every release", () => {
  it("fits npm's package-page limit with margin", () => {
    const bytes = Buffer.byteLength(README, "utf8");
    assert.ok(bytes < 60_000, `README.md is ${bytes} bytes; npm truncates near 64 KB`);
  });

  it("names the package.json version in its what's-new section", () => {
    const major = VERSION.split(".")[0];
    const start = README.indexOf(`## What's new in ${major}.x`);
    assert.ok(start >= 0, `README has no "## What's new in ${major}.x" section`);
    const end = README.indexOf("\n## ", start + 1);
    const section = README.slice(start, end < 0 ? undefined : end);
    assert.ok(section.includes(VERSION), `the what's-new section does not mention ${VERSION}`);
  });
});
