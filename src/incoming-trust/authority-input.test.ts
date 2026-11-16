import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import type { IncomingTrustAction } from "./authority-store.js";
import { storeFixture } from "./authority-store.test-support.js";

it("refuses a non-string action name without clearing a rejection", () => {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const rejected = f.store.update(f.repository, {
      type: "reject",
      expectedGeneration: 1,
      expectedPhase: "pending",
    });
    const action = JSON.parse(
      '{"type":["retry"],"expectedGeneration":2,"expectedPhase":"rejected"}',
    ) as IncomingTrustAction;
    assert.throws(() => f.store.update(f.repository, action), /invalid-action/);
    assert.deepEqual(f.store.read(f.repository), rejected);
  } finally {
    f.cleanup();
  }
});

for (const input of [
  "null",
  "[]",
  '{"type":"constructor","expectedGeneration":1}',
  '{"type":"stage","expectedGeneration":0,"candidateDigest":"invalid","expectedPhase":"pending"}',
  '{"type":"stage","expectedGeneration":1,"candidateDigest":"invalid","expectedPhase":"pending"}',
  '{"type":"reject","expectedGeneration":1,"extra":true}',
  '{"type":"retry"}',
]) {
  it(`refuses invalid input ${input} without creating an authority store`, () => {
    const f = storeFixture();
    try {
      const action = JSON.parse(input) as IncomingTrustAction;
      assert.throws(() => f.store.update(f.repository, action), /invalid-action/);
      assert.equal(existsSync(f.directory), false);
    } finally {
      f.cleanup();
    }
  });
}
