import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  interpretFileVault,
  interpretBitLocker,
  interpretLsblk,
  memoryDirInsideRepo,
  checkMemoryDirSafety,
} from "./check-disk-encryption.js";

describe("interpretFileVault", () => {
  it("detects on / off / unknown", () => {
    assert.equal(interpretFileVault("FileVault is On."), true);
    assert.equal(interpretFileVault("FileVault is Off."), false);
    assert.equal(interpretFileVault("something else"), null);
  });
});

describe("interpretBitLocker", () => {
  it("detects protection on / off / unknown", () => {
    assert.equal(interpretBitLocker("Conversion Status: ... Protection On"), true);
    assert.equal(interpretBitLocker("Protection Off"), false);
    assert.equal(interpretBitLocker("Percentage Encrypted: Fully Decrypted"), false);
    assert.equal(interpretBitLocker("weird output"), null);
  });
});

describe("interpretLsblk", () => {
  it("returns true only when a crypt device is present", () => {
    assert.equal(interpretLsblk("TYPE\ndisk\npart\ncrypt\nlvm"), true);
    assert.equal(interpretLsblk("TYPE\ndisk\npart\nlvm"), null);
    // must not match substrings like "encrypted" in some other column
    assert.equal(interpretLsblk("TYPE\ncryptosomething"), null);
  });
});

describe("memoryDirInsideRepo", () => {
  it("flags a memory dir inside the repo tree", () => {
    assert.equal(memoryDirInsideRepo("/home/u/proj/.kit", "/home/u/proj"), true);
    assert.equal(memoryDirInsideRepo("/home/u/proj", "/home/u/proj"), true);
  });
  it("passes the default homedir store (outside the repo)", () => {
    assert.equal(memoryDirInsideRepo("/home/u/.kit", "/home/u/proj"), false);
    // sibling prefix must not false-positive
    assert.equal(memoryDirInsideRepo("/home/u/project-2/.kit", "/home/u/proj"), false);
  });
});

describe("checkMemoryDirSafety", () => {
  it("returns a well-formed exposure result and never throws", () => {
    const r = checkMemoryDirSafety();
    assert.equal(r.category, "exposure");
    assert.ok(["pass", "warn", "skip"].includes(r.status));
    assert.equal(typeof r.detail, "string");
  });
});
