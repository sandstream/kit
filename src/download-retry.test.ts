import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./download-retry.js";

const URL_OK = "https://example.test/asset.tar.gz";

function reply(status: number, body = "data", url = URL_OK): Response {
  const res = new Response(status === 200 ? body : "x", { status });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

/** A fetch that plays back the given steps, one per call, and counts the calls. */
function script(steps: Array<Response | Error>) {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    const step = steps[Math.min(state.calls++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

const noWait = {
  sleep: async () => {},
  delayMs: () => 0,
};

describe("fetchWithRetry: what is retried", () => {
  it("returns the body at once when the first answer is 200", async () => {
    const { state, fetchImpl } = script([reply(200, "abc")]);
    const buf = await fetchWithRetry(URL_OK, { timeoutMs: 1000, fetchImpl, ...noWait });
    assert.equal(buf.toString(), "abc");
    assert.equal(state.calls, 1);
  });

  it("tries again after a 504 and returns the later 200", async () => {
    const { state, fetchImpl } = script([reply(504), reply(502), reply(200, "ok")]);
    const buf = await fetchWithRetry(URL_OK, { timeoutMs: 1000, fetchImpl, ...noWait });
    assert.equal(buf.toString(), "ok");
    assert.equal(state.calls, 3);
  });

  it("tries again after a network error", async () => {
    const { state, fetchImpl } = script([new TypeError("fetch failed"), reply(200, "ok")]);
    await fetchWithRetry(URL_OK, { timeoutMs: 1000, fetchImpl, ...noWait });
    assert.equal(state.calls, 2);
  });

  it("retries 408 and 429", async () => {
    const { state, fetchImpl } = script([reply(408), reply(429), reply(200)]);
    await fetchWithRetry(URL_OK, { timeoutMs: 1000, fetchImpl, ...noWait });
    assert.equal(state.calls, 3);
  });
});

describe("fetchWithRetry: what is not retried, and when it stops", () => {
  it("does not retry an answer that will not change (404)", async () => {
    const { state, fetchImpl } = script([reply(404), reply(200)]);
    await assert.rejects(
      fetchWithRetry(URL_OK, { timeoutMs: 1000, fetchImpl, ...noWait }),
      /HTTP 404/,
    );
    assert.equal(state.calls, 1);
  });

  it("refuses a redirect off HTTPS without retrying", async () => {
    const { state, fetchImpl } = script([reply(200, "x", "http://example.test/a"), reply(200)]);
    await assert.rejects(
      fetchWithRetry(URL_OK, { timeoutMs: 1000, fetchImpl, ...noWait }),
      /non-https/,
    );
    assert.equal(state.calls, 1);
  });

  it("gives up after the attempt limit and says how many it made", async () => {
    const { state, fetchImpl } = script([reply(504)]);
    await assert.rejects(
      fetchWithRetry(URL_OK, { timeoutMs: 1000, attempts: 3, fetchImpl, ...noWait }),
      /HTTP 504 fetching .* \(after 3 attempts\)/,
    );
    assert.equal(state.calls, 3);
  });

  it("waits between attempts with the delay it is given, not after the last one", async () => {
    const waits: number[] = [];
    const { fetchImpl } = script([reply(500)]);
    await assert.rejects(
      fetchWithRetry(URL_OK, {
        timeoutMs: 1000,
        attempts: 3,
        fetchImpl,
        sleep: async (ms) => {
          waits.push(ms);
        },
        delayMs: (n) => n * 10,
      }),
    );
    assert.deepEqual(waits, [10, 20]);
  });

  it("treats a timeout as retryable", async () => {
    let calls = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      return Promise.resolve(reply(200, "late"));
    }) as unknown as typeof fetch;
    const buf = await fetchWithRetry(URL_OK, { timeoutMs: 20, fetchImpl, ...noWait });
    assert.equal(buf.toString(), "late");
    assert.equal(calls, 2);
  });
});
