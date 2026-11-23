import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { applySignedPairAtomically } from "./signed-file-pair.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-signed-pair-"));
  t.after(() => rmTemp(root));
  return {
    root,
    target: {
      document: join(root, "profile.toml"),
      signature: join(root, "profile.sig"),
      kind: "profile" as const,
    },
  };
}

const previousDocument = Buffer.from([0x61, 0x0d, 0x0a]);
const previousSignature = Buffer.from([0x00, 0x80, 0xff]);
const nextDocument = Buffer.from("version = 2\n");
const nextSignature = Buffer.from([0x80, 0x0a, 0x00]);

it("publishes the supplied document and signature bytes", (t) => {
  const { root, target } = fixture(t);
  const result = applySignedPairAtomically(target, nextDocument, nextSignature);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(readFileSync(target.document), nextDocument);
  assert.deepEqual(readFileSync(target.signature), nextSignature);
  assert.deepEqual(readdirSync(root).sort(), ["profile.sig", "profile.toml"]);
});

for (const existingSignature of [true, false]) {
  it(`retains the previous pair when document publication fails (signature present: ${existingSignature})`, (t) => {
    const { root, target } = fixture(t);
    writeFileSync(target.document, previousDocument);
    if (existingSignature) {
      writeFileSync(target.signature, previousSignature, { mode: 0o600 });
    }
    const previousMode = existingSignature ? statSync(target.signature).mode & 0o777 : undefined;
    const result = applySignedPairAtomically(target, nextDocument, nextSignature, (from, to) => {
      if (to === target.document) {
        assert.deepEqual(readFileSync(target.signature), nextSignature);
        throw Object.assign(new Error("test rename failure"), { code: "EIO" });
      }
      renameSync(from, to);
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /EIO.*previous pair retained/);
    assert.deepEqual(readFileSync(target.document), previousDocument);
    if (existingSignature) {
      assert.deepEqual(readFileSync(target.signature), previousSignature);
      assert.equal(statSync(target.signature).mode & 0o777, previousMode);
    }
    const expectedFiles = existingSignature ? ["profile.sig", "profile.toml"] : ["profile.toml"];
    assert.deepEqual(readdirSync(root).sort(), expectedFiles);
  });
}
