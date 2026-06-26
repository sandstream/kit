import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reReadHexKey } from "./key-file.js";

describe("reReadHexKey - create-race guard (FIX 5)", () => {
  it("returns a full 32-byte key for a valid 64-hex file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-keyfile-ok-"));
    try {
      const p = join(dir, "k");
      writeFileSync(p, "a".repeat(64) + "\n", "utf-8");
      const buf = await reReadHexKey(p);
      assert.equal(buf.length, 32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ATTACK: a too-short (mid-write) hex re-read THROWS instead of returning an empty key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-keyfile-short-"));
    try {
      const p = join(dir, "k");
      writeFileSync(p, "abc", "utf-8"); // partial write, stays short
      await assert.rejects(() => reReadHexKey(p, 64, 3), /did not become readable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ATTACK: an empty file never yields a zero-length key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-keyfile-empty-"));
    try {
      const p = join(dir, "k");
      writeFileSync(p, "", "utf-8");
      await assert.rejects(() => reReadHexKey(p, 64, 2), /did not become readable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries and succeeds once the winner finishes writing the full key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-keyfile-retry-"));
    try {
      const p = join(dir, "k");
      writeFileSync(p, "abc", "utf-8"); // starts short
      // Winner flushes the full key shortly after, before attempts exhaust.
      setTimeout(() => writeFileSync(p, "b".repeat(64) + "\n", "utf-8"), 25);
      const buf = await reReadHexKey(p, 64, 6);
      assert.equal(buf.length, 32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
