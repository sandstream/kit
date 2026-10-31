import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  describeBlob,
  findStreams,
  inspectBlob,
  looksBinary,
  mediaKind,
  UNKNOWN_WARN_BYTES,
} from "./triage-sandbox-blob.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

/** A fake Linux boot image: zeros with "HdrS" at 0x202. */
function bootImage(size = 0x1000): Buffer {
  const b = Buffer.alloc(size);
  b.write("HdrS", 0x202, "latin1");
  return b;
}

/** A container like `ruvbot.rvf`: a binary header, then a gzip stream at `offset`. */
function container(payload: Buffer, offset = 192): Buffer {
  const head = Buffer.alloc(offset);
  head.write("SFVR", 0, "latin1");
  return Buffer.concat([head, gzipSync(payload)]);
}

/** A one-entry zip local header holding `payload` deflated. */
function zipEntry(name: string, payload: Buffer): Buffer {
  const data = deflateRawSync(payload);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(8, 8);
  h.writeUInt32LE(data.length, 18);
  h.writeUInt32LE(payload.length, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([Buffer.from([0, 0, 0, 0]), h, Buffer.from(name), data]);
}

describe("looksBinary and mediaKind", () => {
  it("uses git's NUL rule and recognises media by its first bytes", () => {
    assert.equal(looksBinary(Buffer.from("const a = 1;\n")), false);
    assert.equal(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true);
    assert.equal(mediaKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), "PNG");
    assert.equal(mediaKind(Buffer.from("wOF2\0\0")), "WOFF");
    assert.equal(mediaKind(Buffer.from("SFVR\0\0")), null);
  });
});

describe("findStreams", () => {
  it("finds gzip, zip, xz and zstd magic at any offset, in file order", () => {
    const b = Buffer.concat([
      Buffer.alloc(10),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.alloc(5),
      Buffer.from([0x1f, 0x8b, 0x08]),
    ]);
    assert.deepEqual(
      findStreams(b).map((s) => [s.format, s.offset]),
      [
        ["zstd", 10],
        ["gzip", 19],
      ],
    );
  });
});

describe("describeBlob", () => {
  it("finds a boot image one gzip layer inside a container, as in a real package", () => {
    const blob = container(bootImage());
    const f = describeBlob("ruvbot.rvf", blob, blob.length);
    assert.equal(f?.severity, "warn");
    assert.match(
      f?.detail ?? "",
      /^ruvbot\.rvf: Linux kernel boot image inside a gzip stream at offset 192/,
    );
  });

  it("finds an ELF inside a deflated zip entry", () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(200)]);
    const blob = zipEntry("payload", elf);
    assert.match(
      describeBlob("data.bin", blob, blob.length)?.detail ?? "",
      /ELF executable or library inside a zip stream at offset 4/,
    );
  });

  it("flags binary content behind a text extension", () => {
    const b = Buffer.from([0x13, 0x37, 0x00, 0x42]);
    assert.deepEqual(describeBlob("lib/index.js", b, 4), {
      severity: "warn",
      detail: "lib/index.js: binary content in a text file (4 bytes)",
    });
  });

  it("calls a small unknown binary info and a large one a warning, naming xz it cannot open", () => {
    const b = Buffer.concat([Buffer.alloc(8), Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])]);
    assert.equal(describeBlob("model.bin", b, 100)?.severity, "info");
    const big = describeBlob("model.bin", b, UNKNOWN_WARN_BYTES);
    assert.equal(big?.severity, "warn");
    assert.match(
      big?.detail ?? "",
      /unknown binary \(\d+ bytes, contains a xz stream kit cannot open\)/,
    );
  });

  it("says nothing about text or known media", () => {
    assert.equal(describeBlob("README.md", Buffer.from("# hi\n"), 5), null);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);
    assert.equal(describeBlob("logo.png", png, png.length), null);
  });

  it("does not expand a decompression bomb past its ceiling", () => {
    const bomb = container(Buffer.alloc(64 * 1024 * 1024));
    const f = describeBlob("bomb.bin", bomb, bomb.length);
    assert.match(f?.detail ?? "", /^bomb\.bin: unknown binary/);
  });
});

describe("inspectBlob", () => {
  it("reads a file from disk and stops early on text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-blob-"));
    try {
      const blob = container(bootImage());
      writeFileSync(join(dir, "ruvbot.rvf"), blob);
      writeFileSync(join(dir, "index.js"), "export default 1;\n");
      const f = await inspectBlob(join(dir, "ruvbot.rvf"), "ruvbot.rvf", blob.length);
      assert.match(f?.detail ?? "", /Linux kernel boot image inside a gzip stream/);
      assert.equal(await inspectBlob(join(dir, "index.js"), "index.js", 18), null);
      assert.equal(await inspectBlob(join(dir, "missing"), "missing", 0), null);
    } finally {
      rmTemp(dir);
    }
  });
});
