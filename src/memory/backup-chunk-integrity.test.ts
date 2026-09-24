import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "node:test";
import { closedSource, fixture, modes } from "./backup.test-support.js";

const mutations = [
  {
    name: "tampered ciphertext",
    apply(blob: Buffer) {
      const changed = Buffer.from(blob);
      changed[changed.length - 1] ^= 0xff;
      return changed;
    },
  },
  {
    name: "truncated ciphertext",
    apply: (blob: Buffer) => blob.subarray(0, blob.length - 1),
  },
  {
    name: "trailing bytes",
    apply: (blob: Buffer) => Buffer.concat([blob, Buffer.from("unexpected")]),
  },
] as const;

for (const mode of modes) {
  for (const mutation of mutations) {
    it(`${mode.name}: ${mutation.name} cannot publish chunked plaintext`, (t) => {
      const files = fixture(t);
      closedSource(files.src);
      mode.backup(files.src, files.blob);
      writeFileSync(files.blob, mutation.apply(readFileSync(files.blob)));

      assert.throws(() => mode.restore(files.blob, files.dest));
      assert.equal(existsSync(files.dest), false);
    });
  }
}
