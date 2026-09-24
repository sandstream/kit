import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palConfigure, palList } from "./pal.js";
import { fixture as backupFixture, modes } from "./backup.test-support.js";

async function fixture(t: TestContext) {
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "source-device";
  t.after(() => {
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  const files = backupFixture(t);
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    response.end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { ...files, calls, url: `http://127.0.0.1:${address.port}/check` };
}

for (const mode of modes) {
  it(`${mode.name} backup restore does not authorize another device's HTTP check`, async (t) => {
    const { src, blob, dest, track, calls, url } = await fixture(t);
    const source = track(openMemoryDb(src));
    const id = palAdd(source, {
      title: "verify on the source device",
      check: { type: "http-status", url, expect: 200 },
    });
    mode.backup(src, blob);
    process.env.KIT_DEVICE_ID = "destination-device";
    mode.restore(blob, dest);
    const restored = track(openMemoryDb(dest));
    const before = palList(restored, { allDevices: true, readOnly: true });
    const result = await palAutoVerify(restored, 1);
    assert.deepEqual(calls, [], "restoring history does not approve source-authored requests");
    assert.equal(result.checked, 0);
    assert.deepEqual(result.closed, []);
    assert.deepEqual(palList(restored, { allDevices: true, readOnly: true }), before);
    assert.equal(result.unverified[0]?.id, id);

    assert.equal(palConfigure(restored, id, { type: "http-status", url, expect: 200 }), true);
    assert.deepEqual((await palAutoVerify(restored, 1)).closed, [id]);
    assert.deepEqual(calls, ["/check"]);
    const closed = palList(restored, { allDevices: true, status: "closed", readOnly: true });
    assert.equal(closed[0]?.origin_device, "source-device");
  });
}
