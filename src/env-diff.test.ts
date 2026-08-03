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

describe("formatEnvDiff — section structure and redaction", () => {
  const empty = { onlyInA: [], onlyInB: [], changed: [], identicalCount: 0 };

  it("renders a clean report with no sections when the two files agree", () => {
    const out = formatEnvDiff(empty, "local", "staging");
    const lines = out.split("\n");
    // Exact shape, because this is what a passing `kit env diff` prints: header,
    // horizontal rule, blank, count — four lines, nothing that reads as drift.
    // The rule's width is cosmetic, so match its characters rather than a length.
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "env-diff local vs staging");
    assert.match(lines[1]!, /^─+$/);
    assert.equal(lines[2], "");
    assert.equal(lines[3], "Identical keys: 0");
  });

  it("omits the Changed and Only-in headings entirely when those lists are empty", () => {
    const out = formatEnvDiff({ ...empty, identicalCount: 4 }, "local", "staging");
    // An empty section must not print its heading with "(0)" — a report that
    // says "Changed (0):" reads as drift to a human skimming CI output.
    assert.ok(!out.includes("Changed"), `unexpected Changed heading in:\n${out}`);
    assert.ok(!out.includes("Only in"), `unexpected Only-in heading in:\n${out}`);
  });

  it("reports the identical-key count as the last line, with no trailing newline", () => {
    const out = formatEnvDiff({ ...empty, identicalCount: 7 }, "a", "b");
    const lines = out.split("\n");
    assert.equal(lines[lines.length - 1], "Identical keys: 7");
    // Callers console.log() this; a trailing newline would double-space the tail.
    assert.ok(!out.endsWith("\n"));
  });

  it("orders the sections Changed, then only-in-A, then only-in-B", () => {
    const out = formatEnvDiff(
      {
        onlyInA: ["A_ONLY"],
        onlyInB: ["B_ONLY"],
        changed: [{ key: "SHARED", aHash: "11111111", bHash: "22222222" }],
        identicalCount: 0,
      },
      "local",
      "staging",
    );
    const changedAt = out.indexOf("Changed (1):");
    const onlyAAt = out.indexOf("Only in local (1):");
    const onlyBAt = out.indexOf("Only in staging (1):");
    assert.ok(changedAt !== -1 && onlyAAt !== -1 && onlyBAt !== -1);
    // Changed keys are the actionable finding, so they lead; the two
    // only-in blocks follow in A-then-B order to match the header's "A vs B".
    assert.ok(changedAt < onlyAAt, "Changed must precede the only-in-A block");
    assert.ok(onlyAAt < onlyBAt, "only-in-A must precede only-in-B");
  });

  it("renders one marked line per entry, with counts matching the list lengths", () => {
    const out = formatEnvDiff(
      {
        onlyInA: ["A1", "A2"],
        onlyInB: ["B1"],
        changed: [
          { key: "K1", aHash: "aaaaaaaa", bHash: "bbbbbbbb" },
          { key: "K2", aHash: "cccccccc", bHash: "dddddddd" },
        ],
        identicalCount: 3,
      },
      "local",
      "staging",
    );
    const lines = out.split("\n");
    assert.ok(lines.includes("Changed (2):"));
    assert.ok(lines.includes("Only in local (2):"));
    assert.ok(lines.includes("Only in staging (1):"));
    // The per-entry line format is what a developer greps for, so pin it whole
    // rather than loosely matching the key.
    assert.ok(lines.includes("  ⚠  K1  local=aaaaaaaa…  staging=bbbbbbbb…"));
    assert.ok(lines.includes("  ⚠  K2  local=cccccccc…  staging=dddddddd…"));
    assert.ok(lines.includes("  +  A1"));
    assert.ok(lines.includes("  +  A2"));
    assert.ok(lines.includes("  -  B1"));
  });

  it("preserves the caller's array order instead of re-sorting", () => {
    const out = formatEnvDiff(
      {
        onlyInA: ["ZEBRA", "ALPHA"],
        onlyInB: [],
        changed: [
          { key: "ZED", aHash: "11111111", bHash: "22222222" },
          { key: "ABE", aHash: "33333333", bHash: "44444444" },
        ],
        identicalCount: 0,
      },
      "a",
      "b",
    );
    // Sorting is diffEnvFiles' job; the formatter is a pure renderer. Pinning
    // this documents where the ordering guarantee actually lives.
    assert.ok(out.indexOf("ZEBRA") < out.indexOf("ALPHA"));
    assert.ok(out.indexOf("ZED") < out.indexOf("ABE"));
  });

  it("interpolates the labels verbatim in both the header and the changed lines", () => {
    const out = formatEnvDiff(
      {
        onlyInA: ["A_ONLY"],
        onlyInB: ["B_ONLY"],
        changed: [{ key: "K", aHash: "aaaaaaaa", bHash: "bbbbbbbb" }],
        identicalCount: 0,
      },
      ".env.local",
      ".env.staging",
    );
    assert.ok(out.startsWith("env-diff .env.local vs .env.staging\n"));
    assert.ok(out.includes("  ⚠  K  .env.local=aaaaaaaa…  .env.staging=bbbbbbbb…"));
    assert.ok(out.includes("Only in .env.local (1):"));
    assert.ok(out.includes("Only in .env.staging (1):"));
  });

  it("never leaks a plaintext value when rendering a real diffEnvFiles result", async () => {
    const secretA = "sk-live-AAAA-do-not-print";
    const secretB = "sk-live-BBBB-do-not-print";
    const dir = fixture((d) => {
      writeFileSync(join(d, ".env.a"), `API_KEY=${secretA}\nSHARED=same\nA_ONLY=1\n`);
      writeFileSync(join(d, ".env.b"), `API_KEY=${secretB}\nSHARED=same\nB_ONLY=2\n`);
    });
    try {
      const diff = await diffEnvFiles(".env.a", ".env.b", dir);
      const out = formatEnvDiff(diff, "local", "staging");
      // The whole point of the hash-prefix design: the rendered report is safe
      // to paste into a ticket or CI log. Key names may appear, values may not.
      assert.ok(!out.includes(secretA), `formatted output leaked the A value:\n${out}`);
      assert.ok(!out.includes(secretB), `formatted output leaked the B value:\n${out}`);
      assert.ok(!out.includes("sk-live"));
      assert.ok(!out.includes("same"), `formatted output leaked an identical value:\n${out}`);
      // It still has to be useful: the drifting key is named and both hashes shown.
      assert.ok(out.includes("API_KEY"));
      assert.ok(out.includes(diff.changed[0]!.aHash));
      assert.ok(out.includes(diff.changed[0]!.bHash));
      assert.ok(out.includes("Identical keys: 1"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
