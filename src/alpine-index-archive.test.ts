import assert from "node:assert/strict";
import { it } from "node:test";
import { gzipSync } from "node:zlib";
import { apkIndexText } from "./dockerfile-apk-floors.js";
import { tarOf } from "./apk-index.test-support.js";

const TEXT = "P:binary-a\nV:2.0-r0\no:source-a\n\n";
const INDEX = tarOf({ APKINDEX: TEXT });
const SIGNATURE = tarOf({ ".SIGN.RSA.fixture.pub": "signature" }).subarray(0, -1024);

function repairChecksum(header: Buffer): void {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

function changedHeader(offset: number, value: string): Buffer {
  const archive = Buffer.from(INDEX);
  archive.write(value, offset, "latin1");
  repairChecksum(archive.subarray(0, 512));
  return gzipSync(archive);
}

function pax(key: string, value: string): Buffer {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail) + 1;
  while (String(length).length + Buffer.byteLength(tail) !== length)
    length = String(length).length + Buffer.byteLength(tail);
  const archive = tarOf({ "PaxHeaders/signature": `${length}${tail}` }).subarray(0, -1024);
  archive[156] = "x".charCodeAt(0);
  repairChecksum(archive.subarray(0, 512));
  return archive;
}

it("accepts unsigned, signed-fragment, PAX, and multiple-signature structures", () => {
  for (const prefix of [
    Buffer.alloc(0),
    SIGNATURE,
    Buffer.concat([pax("mtime", "1.25"), SIGNATURE]),
    Buffer.concat([SIGNATURE, tarOf({ ".SIGN.RSA.second.pub": "second" }).subarray(0, -1024)]),
  ]) {
    const gzip = prefix.length
      ? Buffer.concat([gzipSync(prefix), gzipSync(INDEX)])
      : gzipSync(INDEX);
    assert.equal(apkIndexText(gzip), TEXT);
  }
});

it("accepts the GNU header encoding used by Alpine", () => {
  assert.equal(apkIndexText(changedHeader(257, "ustar  \0")), TEXT);
});

it("accepts the email-based signature key names used by Alpine", () => {
  const signature = tarOf({
    ".SIGN.RSA.alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub": "signature",
  }).subarray(0, -1024);
  assert.equal(apkIndexText(Buffer.concat([gzipSync(signature), gzipSync(INDEX)])), TEXT);
});

for (const [name, archive] of [
  ["truncated body", INDEX.subarray(0, 522)],
  ["missing file padding", INDEX.subarray(0, 512 + Buffer.byteLength(TEXT))],
  ["missing terminator", INDEX.subarray(0, -1024)],
  ["one zero block", INDEX.subarray(0, -512)],
  ["partial final block", INDEX.subarray(0, -1)],
  ["duplicate index", Buffer.concat([INDEX.subarray(0, -1024), INDEX])],
  ["data after terminator", Buffer.concat([INDEX, tarOf({ OTHER: "hidden" })])],
  ["dangling metadata", Buffer.concat([pax("mtime", "1"), Buffer.alloc(1024)])],
  ["unsupported PAX path", Buffer.concat([pax("path", "APKINDEX"), INDEX])],
] as const) {
  it(`refuses ${name}`, () => assert.throws(() => apkIndexText(gzipSync(archive))));
}

for (const [name, offset, value] of [
  ["invalid size digit", 124, "00000000018\0"],
  ["numeric suffix junk", 124, "0000000001x\0"],
  ["hidden numeric junk", 124, "1\0junk\0\0\0\0\0\0"],
  ["huge size", 124, "777777777777"],
  ["invalid mode", 100, "0000080\0"],
  ["numeric final newline", 124, "00000000001\n"],
  ["link entry", 156, "2"],
  ["prefix changes path", 345, "nested"],
] as const) {
  it(`refuses ${name} with a valid checksum`, () => {
    assert.throws(() => apkIndexText(changedHeader(offset, value)));
  });
}

it("refuses a bad header checksum", () => {
  const badHeader = Buffer.from(INDEX);
  badHeader[100] ^= 1;
  assert.throws(() => apkIndexText(gzipSync(badHeader)));
});

it("refuses a corrupt gzip trailer", () => {
  const badTrailer = gzipSync(INDEX);
  badTrailer[badTrailer.length - 8] ^= 1;
  assert.throws(() => apkIndexText(badTrailer));
});

for (const [name, suffix] of [
  ["zero padding", Buffer.alloc(1)],
  ["garbage after zero padding", Buffer.from([0, 1, 2])],
  [
    "a truncated member after zero padding",
    Buffer.concat([Buffer.alloc(1), gzipSync(INDEX).subarray(0, 12)]),
  ],
  ["a hidden index after zero padding", Buffer.concat([Buffer.alloc(1), gzipSync(INDEX)])],
] as const) {
  it(`refuses unread compressed bytes containing ${name}`, () => {
    assert.throws(() => apkIndexText(Buffer.concat([gzipSync(INDEX), suffix])), /unconsumed gzip/);
  });
}

it("accepts a completely consumed empty gzip member after the index", () => {
  assert.equal(apkIndexText(Buffer.concat([gzipSync(INDEX), gzipSync(Buffer.alloc(0))])), TEXT);
});

it("enforces the local PAX metadata boundary", () => {
  const exact = pax("mtime", "1".repeat(65523));
  assert.equal(apkIndexText(gzipSync(Buffer.concat([exact, INDEX]))), TEXT);
  const excessive = pax("mtime", "1".repeat(65524));
  assert.throws(
    () => apkIndexText(gzipSync(Buffer.concat([excessive, INDEX]))),
    /PAX metadata size/,
  );
});

it("bounds cumulative decompression, including content after APKINDEX", () => {
  const complete = gzipSync(INDEX);
  assert.equal(apkIndexText(complete, INDEX.length), TEXT);
  assert.throws(() => apkIndexText(complete, INDEX.length - 1), /maxOutputLength|larger than/);
  const members = Buffer.concat([gzipSync(SIGNATURE), complete]);
  assert.equal(apkIndexText(members, SIGNATURE.length + INDEX.length), TEXT);
  assert.throws(() => apkIndexText(members, INDEX.length), /maxOutputLength|larger than/);
  const largeTail = gzipSync(Buffer.concat([INDEX, Buffer.alloc(8192)]));
  assert.throws(() => apkIndexText(largeTail, INDEX.length), /maxOutputLength|larger than/);
});

it("refuses oversized compressed input and invalid caller limits", () => {
  assert.throws(() => apkIndexText(Buffer.alloc(16 * 1024 * 1024 + 1)), /compressed input/);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 64 * 1024 * 1024 + 1])
    assert.throws(() => apkIndexText(gzipSync(INDEX), limit), /invalid decompression limit/);
});

it("accepts a structurally valid empty index", () => {
  assert.equal(apkIndexText(gzipSync(tarOf({ APKINDEX: "" }))), "");
});

it("rejects nonzero member padding and invalid UTF-8 index bytes", () => {
  const padding = Buffer.from(INDEX);
  padding[512 + Buffer.byteLength(TEXT)] = 1;
  assert.throws(() => apkIndexText(gzipSync(padding)), /nonzero member padding/);
  const invalidText = Buffer.from(INDEX);
  invalidText[512] = 255;
  assert.throws(() => apkIndexText(gzipSync(invalidText)), /invalid UTF-8/);
});

it("rejects incomplete, repeated and malformed timestamp metadata", () => {
  const badLength = pax("mtime", "1");
  badLength[512] = 57;
  for (const metadata of [
    badLength,
    pax("mtime", "1\n"),
    pax("ctime", "invalid"),
    Buffer.concat([pax("mtime", "1"), pax("mtime", "2")]),
  ])
    assert.throws(() => apkIndexText(gzipSync(Buffer.concat([metadata, INDEX]))), /PAX/);
});

it("bounds the number of archive members", () => {
  const atLimit = Buffer.concat([...Array<Buffer>(4095).fill(SIGNATURE), INDEX]);
  assert.equal(apkIndexText(gzipSync(atLimit)), TEXT);
  assert.throws(
    () => apkIndexText(gzipSync(Buffer.concat([SIGNATURE, atLimit]))),
    /too many archive members/,
  );
});
