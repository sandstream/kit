import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryKind, sniffBinary } from "./triage-sandbox-binary.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

/** A buffer of `size` zero bytes with `bytes` written at `at`. */
function head(size: number, ...parts: [number, number[] | string][]): Uint8Array {
  const b = new Uint8Array(size);
  for (const [at, bytes] of parts) {
    const arr = typeof bytes === "string" ? [...bytes].map((c) => c.charCodeAt(0)) : bytes;
    b.set(arr, at);
  }
  return b;
}

describe("binaryKind", () => {
  it("recognises a Linux boot image by HdrS at 0x202", () => {
    assert.equal(binaryKind(head(0x300, [0x202, "HdrS"]))?.kind, "Linux kernel boot image");
  });

  it("recognises ELF, Mach-O and PE executables as warnings", () => {
    const elf = binaryKind(head(64, [0, [0x7f, 0x45, 0x4c, 0x46]]));
    assert.deepEqual(elf, { kind: "ELF executable or library", severity: "warn" });
    for (const magic of [
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
    ]) {
      assert.equal(binaryKind(head(64, [0, magic]))?.kind, "Mach-O executable or library");
    }
    const pe = head(0x100, [0, "MZ"], [0x3c, [0x80, 0, 0, 0]], [0x80, "PE\0\0"]);
    assert.equal(binaryKind(pe)?.kind, "Windows PE executable or library");
  });

  it("tells a Mach-O universal binary from a Java class", () => {
    const fat = head(16, [0, [0xca, 0xfe, 0xba, 0xbe]], [4, [0, 0, 0, 2]]);
    assert.equal(binaryKind(fat)?.kind, "Mach-O universal executable");
    const cls = head(16, [0, [0xca, 0xfe, 0xba, 0xbe]], [4, [0, 0, 0, 0x41]]);
    assert.equal(binaryKind(cls)?.kind, "Java class file");
  });

  it("reports WebAssembly as info, not a warning", () => {
    assert.deepEqual(binaryKind(head(16, [0, "\0asm"])), {
      kind: "WebAssembly module",
      severity: "info",
    });
  });

  it("ignores text, an MZ without a PE header, and short input", () => {
    assert.equal(binaryKind(new TextEncoder().encode("module.exports = 1;\n")), null);
    assert.equal(binaryKind(new TextEncoder().encode("MZ is a fine way to start a README")), null);
    assert.equal(binaryKind(head(0x100, [0, "MZ"], [0x3c, [0xff, 0xff, 0, 0]])), null);
    assert.equal(binaryKind(new Uint8Array([0x7f, 0x45])), null);
  });
});

describe("sniffBinary", () => {
  it("classifies a file from its first bytes and returns null for text or a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sniff-"));
    try {
      writeFileSync(join(dir, "bzImage"), head(0x400, [0x202, "HdrS"]));
      writeFileSync(join(dir, "index.js"), "export default 1;\n");
      assert.equal((await sniffBinary(join(dir, "bzImage")))?.kind, "Linux kernel boot image");
      assert.equal(await sniffBinary(join(dir, "index.js")), null);
      assert.equal(await sniffBinary(join(dir, "missing")), null);
    } finally {
      rmTemp(dir);
    }
  });
});
