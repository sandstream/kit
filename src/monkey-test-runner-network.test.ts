import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { findFreePort, isLoopbackBaseUrl, waitForUrl } from "./monkey-test-runner-network.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

it("allocates a local port usable by an HTTP server", async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
  const server = createServer((_request, response) => response.writeHead(204).end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  assert.equal(
    await waitForUrl(`http://127.0.0.1:${port}/`, 1_000, new AbortController().signal),
    true,
  );
});

it("retries server errors and reports an unreachable endpoint without a false pass", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 503 : 204).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  assert.equal(await waitForUrl(url, 1_500, new AbortController().signal), true);
  assert.ok(requests >= 2);
  assert.equal(await waitForUrl("http://127.0.0.1:1/", 300, new AbortController().signal), false);
});

it("rejects cancellation and only accepts credential-free loopback URLs", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(waitForUrl("http://127.0.0.1:1/", 1_000, cancelled.signal), {
    name: "AbortError",
  });
  assert.equal(isLoopbackBaseUrl("http://localhost:3000"), true);
  assert.equal(isLoopbackBaseUrl("https://[::1]/"), true);
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1/"), true);
  for (const url of [
    "https://example.invalid/",
    "http://operator:secret@localhost/",
    "ftp://localhost/",
    "not a URL",
  ]) {
    assert.equal(isLoopbackBaseUrl(url), false, url);
  }
});
