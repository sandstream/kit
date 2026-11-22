import assert from "node:assert/strict";
import { it } from "node:test";
import {
  FIXTURE_KEY_NAME,
  fixtureIndexKeys,
  signApkIndexFixture,
  unsignedApkIndexFixture,
} from "./apk-index.test-support.js";
import { verifyApkIndex } from "./alpine-index-signature.js";

const payload = unsignedApkIndexFixture(
  "v3.24",
  "P:demo\nV:1-r0\no:demo\n",
  "x86_64",
  1_750_000_000,
);

it("authenticates the exact compressed index and exposes its signed timestamp", () => {
  const result = verifyApkIndex(signApkIndexFixture(payload), fixtureIndexKeys());
  assert.equal(result.signingKey, FIXTURE_KEY_NAME);
  assert.equal(result.mtime, 1_750_000_000);
  assert.match(result.text, /^P:demo\nA:x86_64\n/);
});

it("requires a signature and rejects a fixture key in the default trust set", () => {
  assert.throws(() => verifyApkIndex(payload, fixtureIndexKeys()), /missing separate signature/);
  assert.throws(() => verifyApkIndex(signApkIndexFixture(payload)), /key is not trusted/);
});

it("rejects any bytes appended after signing", () => {
  const signed = signApkIndexFixture(payload);
  assert.throws(
    () => verifyApkIndex(Buffer.concat([signed, Buffer.alloc(1)]), fixtureIndexKeys()),
    /signature verification failed/,
  );
});
