import assert from "node:assert/strict";
import { it } from "node:test";
import { readCappedBody } from "./readCappedBody.js";

it("reads an exact byte limit, including multibyte text", async () => {
  const payload = Buffer.from("café", "utf8");
  const response = new Response(payload);
  assert.deepEqual(await readCappedBody(response, payload.length), payload);
  assert.equal(response.body?.locked, false);
});

it("cancels the response stream when the byte limit is exceeded", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(Uint8Array.of(1, 2, 3));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(await readCappedBody(new Response(stream), 4), null);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
