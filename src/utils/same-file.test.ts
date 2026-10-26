import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityOf, sameIdentity } from "./same-file.js";

const stats = (dev: bigint, ino: bigint) => ({ dev, ino }) as BigIntStats;

describe("sameIdentity", () => {
  it("tells apart ids that a double would round together", () => {
    const high = 2n ** 60n;
    // As numbers both are 1152921504606846976: the case that made Windows refuse a restore.
    assert.equal(Number(high), Number(high + 1n));
    assert.equal(sameIdentity(stats(1n, high), stats(1n, high + 1n)), false);
    assert.equal(sameIdentity(stats(1n, high), stats(1n, high)), true);
  });

  it("never matches an id of 0, a missing file, or another device", () => {
    assert.equal(sameIdentity(stats(1n, 0n), stats(1n, 0n)), false);
    assert.equal(sameIdentity(undefined, stats(1n, 5n)), false);
    assert.equal(sameIdentity(stats(1n, 5n), stats(2n, 5n)), false);
  });

  it("matches a hard link and not a sibling file on disk", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-same-file-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const [a, b, link] = ["a", "b", "a-link"].map((name) => join(dir, name));
    writeFileSync(a!, "a");
    writeFileSync(b!, "b");
    linkSync(a!, link!);
    assert.equal(sameIdentity(identityOf(a!), identityOf(link!)), true);
    assert.equal(sameIdentity(identityOf(a!), identityOf(b!)), false);
    assert.equal(identityOf(join(dir, "missing")), undefined);
  });
});
