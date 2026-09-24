import assert from "node:assert/strict";
import { it } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palConfigure, palList } from "./pal.js";
import { fixture, modes } from "./backup.test-support.js";

for (const mode of modes) {
  it(`${mode.name} same-path restore on the same device needs renewed local approval`, async (t) => {
    const { src, blob, track } = fixture(t);
    const previous = process.env.KIT_DEVICE_ID;
    process.env.KIT_DEVICE_ID = "same-device-restore";
    t.after(() => {
      if (previous === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = previous;
    });
    const source = openMemoryDb(src);
    const check = { type: "file-exists" as const, path: src };
    let id: string;
    try {
      id = palAdd(source, { title: "offline restore", check });
      assert.equal((await palAutoVerify(source)).checked, 1);
      mode.backup(src, blob);
    } finally {
      source.close();
    }
    mode.restore(blob, src);
    const restored = track(openMemoryDb(src));
    const before = palList(restored, { readOnly: true });
    const result = await palAutoVerify(restored, 1);
    assert.equal(result.checked, 0);
    assert.equal(result.unverified[0]?.reason, "no-local-approval");
    assert.deepEqual(palList(restored, { readOnly: true }), before);
    assert.equal(palConfigure(restored, id, check), true);
    assert.deepEqual((await palAutoVerify(restored, 1)).closed, [id]);
  });
}
