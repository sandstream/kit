import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHUNK_BYTES,
  MAX_DECOMPRESSED_BYTES,
  sizeHeader,
  SIZE_HEADER_LEN,
} from "./backup-stream.js";

describe("bounded backup stream framing", () => {
  it("encodes byte and chunk counts in the fixed-width header", () => {
    const header = sizeHeader(CHUNK_BYTES + 1);
    assert.equal(header.length, SIZE_HEADER_LEN);
    assert.equal(header.readBigUInt64BE(0), BigInt(CHUNK_BYTES + 1));
    assert.equal(header.readUInt32BE(8), 2);
  });

  it("refuses invalid or over-limit snapshot sizes", () => {
    for (const bytes of [-1, 1.5, MAX_DECOMPRESSED_BYTES + 1]) {
      assert.throws(() => sizeHeader(bytes), /1024 MB backup limit/);
    }
  });
});
