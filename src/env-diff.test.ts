import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffEnvFiles, formatEnvDiff } from "./env-diff.js";

function fixture(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-envdiff-"));
  setup(dir);
  return dir;
}

describe("diffEnvFiles", () => {
  it("returns empty diff for identical files", async () => {
    const dir = fixture((d) => {
      writeFileSync(join(d, ".env.a"), "KEY=value\nOTHER=x\n");
      writeFileSync(join(d, ".env.b"), "KEY=value\nOTHER=x\n");
    });
    try {
      const diff = await diffEnvFiles(".env.a", ".env.b", dir);
      assert.deepEqual(diff.onlyInA, []);
      assert.deepEqual(diff.onlyInB, []);
      assert.deepEqual(diff.changed, []);
      assert.equal(diff.identicalCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects only-in-A and only-in-B keys", async () => {
    const dir = fixture((d) => {
      writeFileSync(join(d, ".env.a"), "X=1\nY=2\n");
      writeFileSync(join(d, ".env.b"), "X=1\nZ=3\n");
    });
    try {
      const diff = await diffEnvFiles(".env.a", ".env.b", dir);
      assert.deepEqual(diff.onlyInA, ["Y"]);
      assert.deepEqual(diff.onlyInB, ["Z"]);
      assert.equal(diff.identicalCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags changed values with hash-prefixes (never echoes value)", async () => {
    const dir = fixture((d) => {
      writeFileSync(join(d, ".env.a"), "API_KEY=value-a\n");
      writeFileSync(join(d, ".env.b"), "API_KEY=value-b\n");
    });
    try {
      const diff = await diffEnvFiles(".env.a", ".env.b", dir);
      assert.equal(diff.changed.length, 1);
      assert.equal(diff.changed[0]!.key, "API_KEY");
      assert.notEqual(diff.changed[0]!.aHash, diff.changed[0]!.bHash);
      assert.equal(diff.changed[0]!.aHash.length, 8);
      // Hashes must NOT contain the value.
      assert.ok(!diff.changed[0]!.aHash.includes("value"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips quotes when parsing", async () => {
    const dir = fixture((d) => {
      writeFileSync(join(d, ".env.a"), `URL="https://example.com"\n`);
      writeFileSync(join(d, ".env.b"), `URL=https://example.com\n`);
    });
    try {
      const diff = await diffEnvFiles(".env.a", ".env.b", dir);
      assert.equal(diff.changed.length, 0);
      assert.equal(diff.identicalCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats missing file as empty (no crash)", async () => {
    const dir = fixture((d) => {
      writeFileSync(join(d, ".env.a"), "X=1\n");
    });
    try {
      const diff = await diffEnvFiles(".env.a", ".env.missing", dir);
      assert.deepEqual(diff.onlyInA, ["X"]);
      assert.deepEqual(diff.onlyInB, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatEnvDiff", () => {
  it("renders human-readable output", () => {
    const formatted = formatEnvDiff(
      {
        onlyInA: ["Y"],
        onlyInB: ["Z"],
        changed: [{ key: "X", aHash: "aaaa1111", bHash: "bbbb2222" }],
        identicalCount: 1,
      },
      "local",
      "staging",
    );
    assert.match(formatted, /local vs staging/);
    assert.match(formatted, /X.*aaaa1111.*bbbb2222/);
    assert.match(formatted, /\+\s+Y/);
    assert.match(formatted, /-\s+Z/);
    assert.match(formatted, /Identical keys: 1/);
  });
});
