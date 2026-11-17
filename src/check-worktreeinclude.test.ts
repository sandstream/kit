import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorktreeInclude, envEntries } from "./check-worktreeinclude.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function repo(t: { after(fn: () => void): void }, body?: string): string {
  const root = mkdtempSync(join(tmpdir(), "kit-wtinc-"));
  t.after(() => rmTemp(root));
  if (body !== undefined) writeFileSync(join(root, ".worktreeinclude"), body);
  return root;
}

describe("envEntries", () => {
  it("names .env and .env.* entries, in any directory and as globs", () => {
    const body = [
      "# copied into each worktree",
      ".env",
      "/.env.local",
      "apps/web/.env.production",
      "**/.env*",
      "node_modules/",
      "config/local.json",
    ].join("\n");
    assert.deepEqual(envEntries(body), [
      ".env",
      "/.env.local",
      "apps/web/.env.production",
      "**/.env*",
    ]);
  });

  it("ignores comments, negations, placeholders and names that only start alike", () => {
    const body = ["# .env", "!.env", ".env.example", ".env.sample", ".envrc", ".environment"].join(
      "\r\n",
    );
    assert.deepEqual(envEntries(body), []);
  });
});

describe("checkWorktreeInclude", () => {
  it("warns and names each .env entry", (t) => {
    const root = repo(t, ".env\n.env.local\nbuild/cache\n");
    const rows = checkWorktreeInclude(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "warn");
    assert.equal(rows[0].severity, "medium");
    assert.match(rows[0].detail, /"\.env"/);
    assert.match(rows[0].detail, /"\.env\.local"/);
    assert.doesNotMatch(rows[0].detail, /build\/cache/);
  });

  it("is quiet when there is no .worktreeinclude", (t) => {
    assert.deepEqual(checkWorktreeInclude(repo(t)), []);
  });

  it("is quiet when .worktreeinclude lists no .env entry", (t) => {
    assert.deepEqual(checkWorktreeInclude(repo(t, "node_modules/\n.env.example\n")), []);
  });
});
