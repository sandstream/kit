/**
 * The wide lane read from git objects counts what importerCounts() counts on a checkout of the same
 * commit, whatever is in the working tree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importerCounts } from "./review-protected-paths-wide.js";
import {
  importerCountsAtCommit,
  importerCountsFromSources,
  parseCatFileBatch,
} from "./review-gate-importers.js";
import { fakeGit, hubSources, MAIN } from "./review-gate.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();

function repo(t: { after(fn: () => void): void }): string {
  const d = mkdtempSync(join(tmpdir(), "kit-review-gate-importers-"));
  t.after(() => rmTemp(d));
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@example.invalid");
  git(d, "config", "user.name", "t");
  git(d, "config", "core.autocrlf", "false");
  mkdirSync(join(d, "src", "sub"), { recursive: true });
  const files: Record<string, string> = {
    "src/hub.ts": "export const hub = 'ü';\n",
    "src/a.ts": 'import { hub } from "./hub.js";\nexport * from "./sub/index.js";\n',
    "src/b.ts": 'import "./hub.js";\nimport x from "node:fs";\n',
    "src/sub/index.ts": 'export { hub } from "../hub.js";\n',
    "src/a.test.ts": 'import "./a.js";\n',
    "src/types.d.ts": 'import "./hub.js";\n',
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(d, ...p.split("/")), text);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "x");
  return d;
}

describe("review gate wide lane: counting at a commit", () => {
  it("matches importerCounts on a checkout of the same commit", (t) => {
    const d = repo(t);
    const sha = git(d, "rev-parse", "HEAD");
    assert.deepEqual(importerCountsAtCommit(d, sha), importerCounts(d));
    assert.equal(importerCountsAtCommit(d, sha).get("src/hub.ts"), 3);
  });

  it("counts the commit, not the working tree", (t) => {
    const d = repo(t);
    const sha = git(d, "rev-parse", "HEAD");
    writeFileSync(join(d, "src", "b.ts"), "export {};\n");
    assert.equal(importerCountsAtCommit(d, sha).get("src/hub.ts"), 3);
  });

  it("throws when the commit is not in the clone, or is not a sha", (t) => {
    const d = repo(t);
    assert.throws(() => importerCountsAtCommit(d, "e".repeat(40)));
    assert.throws(() => importerCountsAtCommit(d, "HEAD"), /not a commit sha/);
  });

  it("reads git cat-file's batch format by byte length", () => {
    const counts = importerCountsAtCommit(".", MAIN, fakeGit(hubSources(3)));
    assert.equal(counts.get("src/hub.ts"), 3);
    const out = Buffer.from("d blob 2\nab\n");
    assert.throws(() => parseCatFileBatch(out, ["a", "b"]), /ended early/);
    assert.throws(() => parseCatFileBatch(Buffer.from("x missing\n"), ["a"]), /could not read/);
  });

  it("skips test files as importers", () => {
    const counts = importerCountsFromSources(
      new Map([
        ["src/a.ts", "export {};"],
        ["src/a.test.ts", 'import "./a.js";'],
      ]),
    );
    assert.equal(counts.get("src/a.ts"), undefined);
  });
});
