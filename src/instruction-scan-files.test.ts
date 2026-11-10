import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readInstructionFile, scanInstructions } from "./instruction-scan.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("accepts the exact byte limit and preserves UTF-8 across read chunks", (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "kit-instructions-byte-limit-"));
  t.after(() => rmTemp(root));
  const file = join(root, "AGENTS.md");
  const text = "x" + "é".repeat(499_999) + "y";
  assert.equal(Buffer.byteLength(text), 1_000_000);
  fs.writeFileSync(file, text);
  assert.equal(readInstructionFile(file), text);
  fs.appendFileSync(file, "x");
  assert.equal(readInstructionFile(file), null);
  fs.writeFileSync(file, "");
  assert.equal(readInstructionFile(file), "");
});

it("bounds the read when a file grows after its size check", (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "kit-instructions-growth-"));
  t.after(() => rmTemp(root));
  const file = join(root, "AGENTS.md");
  fs.writeFileSync(file, "small");
  const original = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (fd: number) => {
    const stat = original(fd);
    fs.writeFileSync(file, "x".repeat(1_000_001));
    return stat;
  });
  syncBuiltinESMExports();
  try {
    assert.equal(readInstructionFile(file), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it(
  "refuses a named pipe and a linked instruction pipe without waiting for a writer",
  { skip: process.platform === "win32" ? "mkfifo requires POSIX named pipes" : false },
  (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), "kit-instructions-pipe-"));
    t.after(() => rmTemp(root));
    const fifo = join(root, "AGENTS.md");
    execFileSync("mkfifo", [fifo]);
    const link = join(root, "CLAUDE.md");
    fs.symlinkSync(fifo, link);
    const source = import.meta.url.endsWith(".ts");
    const moduleUrl = new URL(
      source ? "./instruction-scan.ts" : "./instruction-scan.js",
      import.meta.url,
    );
    const code = `import { readInstructionFile } from ${JSON.stringify(moduleUrl.href)};
      process.stdout.write(JSON.stringify(readInstructionFile(process.argv[1])));`;
    for (const path of [fifo, link]) {
      const child = spawnSync(
        process.execPath,
        [...(source ? ["--import", "tsx"] : []), "--input-type=module", "-e", code, path],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, "null");
    }
    assert.deepEqual(scanInstructions(root, true).unread, ["AGENTS.md", "CLAUDE.md"]);
  },
);
