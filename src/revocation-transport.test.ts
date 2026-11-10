import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { it, type TestContext } from "node:test";
import { forceRevocationCheck } from "./revocation.js";

async function endpoint(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

it("the enforcement request encodes the agent ID in every endpoint placeholder", async (t) => {
  const requests: Array<{ method?: string; path?: string }> = [];
  const path = "/agents/agent%2Fwith%3Fquery%23fragment/agent%2Fwith%3Fquery%23fragment";
  const url = await endpoint(t, (req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.end(JSON.stringify({ revoked: req.url === path }));
  });
  const result = await forceRevocationCheck({
    agent: { id: "agent/with?query#fragment" },
    revocation: { enabled: true, revocation_endpoint: `${url}/agents/{agent_id}/{agent_id}` },
  });
  assert.equal(result.revoked, true);
  assert.deepEqual(requests, [{ method: "GET", path }]);
});

for (const [id, path] of [
  ["..", "/agents/{agent_id}/status"],
  [".", "/agents/{agent_id}/status"],
  [".", "/agents/{agent_id}{agent_id}/status"],
] as const) {
  it(`agent ID ${id} cannot change the path structure of ${path}`, async (t) => {
    const requests: string[] = [];
    const url = await endpoint(t, (req, res) => {
      requests.push(req.url ?? "");
      res.end('{"revoked":false}');
    });
    const result = await forceRevocationCheck({
      agent: { id },
      revocation: { enabled: true, revocation_endpoint: url + path },
    });
    assert.equal(result.revoked, true);
    assert.deepEqual(requests, []);
  });
}

for (const [id, path, expected] of [
  ["..", "/status?agent={agent_id}", "/status?agent=.."],
  ["..", "/agents/prefix-{agent_id}/status", "/agents/prefix-../status"],
  ["%2e%2e", "/agents/{agent_id}/status", "/agents/%252e%252e/status"],
] as const) {
  it(`agent ID ${id} remains usable as a literal value in ${path}`, async (t) => {
    const requests: string[] = [];
    const url = await endpoint(t, (req, res) => {
      requests.push(req.url ?? "");
      res.end(JSON.stringify({ revoked: req.url !== expected }));
    });
    const result = await forceRevocationCheck({
      agent: { id },
      revocation: { enabled: true, revocation_endpoint: url + path },
    });
    assert.equal(result.revoked, false);
    assert.deepEqual(requests, [expected]);
  });
}

it("an HTTP failure cancels its body and prints no upstream status text or response secrets", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const url = await endpoint(t, (_req, res) => {
    res.on("close", closed);
    res.writeHead(503, "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    res.write("private-response-marker");
  });
  const result = await forceRevocationCheck({
    agent: { id: "test-agent" },
    revocation: { enabled: true, revocation_endpoint: url },
  });
  assert.equal(result.revoked, true);
  await connectionClosed;
  const output = JSON.stringify(warnings);
  assert.match(output, /HTTP 503/);
  assert.doesNotMatch(output, /ghp_abcdefghijklmnopqrstuvwxyz0123456789|private-response-marker/);
});

it(
  "an unfinished success body cannot hold the enforcement check open",
  { timeout: 10_000 },
  async (t) => {
    let requests = 0;
    const url = await endpoint(t, (_req, res) => {
      requests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"revoked":');
    });
    const started = performance.now();
    const result = await forceRevocationCheck({
      agent: { id: "test-agent" },
      revocation: { enabled: true, revocation_endpoint: url },
    });
    assert.equal(result.revoked, true);
    assert.equal(requests, 1);
    assert.ok(performance.now() - started < 9_000);
  },
);
