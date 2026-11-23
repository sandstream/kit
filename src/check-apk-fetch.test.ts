import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultApkFetcher } from "./check-apk-floors.js";

const URL = "https://secdb.alpinelinux.org/";

function connectionFailure(): Error {
  return new TypeError("fetch failed", {
    cause: new AggregateError([
      Object.assign(new Error("IPv4 attempt timed out"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("IPv6 route unavailable"), { code: "EHOSTUNREACH" }),
    ]),
  });
}

it("recovers from the observed dual-stack failure with a bounded retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    assert.equal(input, URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-cache");
    assert.ok(options.signal);
    if (++calls === 1) throw connectionFailure();
    return new Response("complete source", {
      headers: { "last-modified": "Fri, 01 May 2026 15:00:00 GMT" },
    });
  });
  const response = await defaultApkFetcher(URL);
  assert.equal(response.body.toString(), "complete source");
  assert.equal(response.lastModified, "Fri, 01 May 2026 15:00:00 GMT");
  assert.equal(calls, 2);
});

it("reports the observed network codes after exhausting three attempts", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw connectionFailure();
  });
  await assert.rejects(defaultApkFetcher(URL), (error: Error) => {
    assert.match(error.message, /3 attempts/);
    assert.match(error.message, /ETIMEDOUT/);
    assert.match(error.message, /EHOSTUNREACH/);
    return true;
  });
  assert.equal(calls, 3);
});

for (const status of [408, 429, 503]) {
  it(`retries HTTP ${status} then reads the successful body`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      return ++calls === 1 ? new Response(null, { status }) : new Response("complete");
    });
    assert.equal((await defaultApkFetcher(URL)).body.toString(), "complete");
    assert.equal(calls, 2);
  });
}

for (const status of [206, 301, 403, 404]) {
  it(`refuses HTTP ${status} without a retry`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(null, { status });
    });
    await assert.rejects(defaultApkFetcher(URL), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  });
}

it("never retries a certificate failure", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }),
    });
  });
  await assert.rejects(defaultApkFetcher(URL));
  assert.equal(calls, 1);
});

it("refuses Content-Range even when the source reports HTTP 200", async (t) => {
  const mock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("partial", {
        headers: { "content-range": "bytes 0-6/100" },
      }),
  );
  await assert.rejects(defaultApkFetcher(URL), /Content-Range/);
  assert.equal(mock.mock.callCount(), 1);
});

it("does not retry a mixed network and certificate failure", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw new AggregateError([
      Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }),
    ]);
  });
  await assert.rejects(defaultApkFetcher(URL), /CERT_HAS_EXPIRED/);
  assert.equal(mock.mock.callCount(), 1);
});

it("retains a permanent refusal when response cancellation also fails", async (t) => {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw Object.assign(new Error("cancel failed"), { code: "ECONNRESET" });
    },
  });
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 403 }));
  await assert.rejects(defaultApkFetcher(URL), /HTTP 403/);
  assert.equal(mock.mock.callCount(), 1);
});

it("accepts a complete body at the byte limit", async (t) => {
  const payload = new Uint8Array(16 * 1024 * 1024);
  payload[0] = 19;
  payload[payload.length - 1] = 23;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(payload, {
        headers: { "content-length": String(payload.length) },
      }),
  );
  const { body: bytes } = await defaultApkFetcher(URL);
  assert.equal(bytes.length, payload.length);
  assert.equal(bytes[0], 19);
  assert.equal(bytes[bytes.length - 1], 23);
});

for (const url of [
  "http://secdb.alpinelinux.org/",
  "https://example.com/",
  "https://user:example@secdb.alpinelinux.org/",
]) {
  it(`rejects an unapproved source without network access: ${url}`, async (t) => {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("unexpected"));
    await assert.rejects(defaultApkFetcher(url), /Expected an HTTPS Alpine source/);
    assert.equal(mock.mock.callCount(), 0);
  });
}

it("retries a timeout before accepting a complete source", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) throw new DOMException("attempt timeout", "TimeoutError");
    return new Response("complete");
  });
  assert.equal((await defaultApkFetcher(URL)).body.toString(), "complete");
  assert.equal(calls, 2);
});

it("discards a partial body before retrying a connection reset", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls > 1) return new Response("complete");
    let reads = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (++reads === 1) controller.enqueue(new TextEncoder().encode("partial"));
          else controller.error(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
        },
      }),
    );
  });
  assert.equal((await defaultApkFetcher(URL)).body.toString(), "complete");
  assert.equal(calls, 2);
});

it("cancels an oversized stream before consuming the full body", async (t) => {
  let chunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      if (chunks === 8) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(body));
  await assert.rejects(defaultApkFetcher(URL), /16777216 bytes/);
  assert.equal(cancelled, true);
  assert.ok(chunks < 8, `read all ${chunks} chunks before refusal`);
  assert.equal(mock.mock.callCount(), 1);
});

it("refuses an oversized declared length without consuming its body", async (t) => {
  let consumed = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        consumed++;
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(body, {
        headers: { "content-length": "16777217" },
      }),
  );
  await assert.rejects(defaultApkFetcher(URL), /16777216 bytes/);
  assert.equal(consumed, 0);
  assert.equal(cancelled, true);
});
