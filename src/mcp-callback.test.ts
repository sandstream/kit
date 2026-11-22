/**
 * kit-research t3code-mcp-sign-in-vs-kit: a sign-in started on a remote machine ends on a
 * `localhost` page the browser cannot load. `kit mcp callback` checks the pasted address and
 * requests it on the machine where the listener is. It never prints the address.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkCallback, deliverCallback } from "./mcp-callback.js";
import { trailCommandRefusal } from "./trail-guard.js";

const AUTH =
  "https://mcp.example/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A33418%2Fcallback&state=st4te&code_challenge=abc";
const GOOD = "http://localhost:33418/callback?code=c0de-c0de-c0de&state=st4te";

describe("checkCallback", () => {
  it("accepts the callback of the sign-in given with --for", () => {
    const r = checkCallback(GOOD, AUTH);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.bound, r.outcome], [true, "code"]);
  });

  it("adds back the http:// an address bar hides, and accepts an error callback", () => {
    assert.equal(checkCallback("localhost:33418/callback?code=c0de&state=st4te", AUTH).ok, true);
    const err = checkCallback("http://127.0.0.1:9/cb?error=access_denied&state=s");
    assert.equal(err.ok && err.outcome === "error" && !err.bound, true);
  });

  const refused: [string, string, string | undefined, RegExp][] = [
    [
      "another state",
      "http://localhost:33418/callback?code=c&state=other",
      AUTH,
      /does not belong/,
    ],
    ["another port", "http://localhost:4000/callback?code=c&state=st4te", AUTH, /does not belong/],
    ["another path", "http://localhost:33418/else?code=c&state=st4te", AUTH, /does not belong/],
    [
      "a non-loopback host",
      "https://evil.example/callback?code=c&state=s",
      undefined,
      /not this machine/,
    ],
    ["two codes", "http://localhost:1/cb?code=a&code=b&state=s", undefined, /exactly one code/],
    [
      "a code and an error",
      "http://localhost:1/cb?code=a&error=b&state=s",
      undefined,
      /exactly one code/,
    ],
    ["no state", "http://localhost:1/cb?code=a", undefined, /exactly one state/],
    ["userinfo", "http://u:p@localhost:1/cb?code=a&state=s", undefined, /username, password/],
    ["a fragment", "http://localhost:1/cb?code=a&state=s#x", undefined, /fragment/],
    ["not a URL", "http://", undefined, /not an address/],
    ["a --for without redirect_uri", GOOD, "https://mcp.example/authorize?x=1", /no redirect_uri/],
  ];
  for (const [label, pasted, auth, why] of refused) {
    it(`refuses ${label}`, () => {
      const r = checkCallback(pasted, auth);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.why, why);
    });
  }

  it("refuses an address over the length cap", () => {
    const r = checkCallback(`http://localhost:1/cb?state=s&code=${"a".repeat(17_000)}`);
    assert.equal(r.ok, false);
  });
});

function listener(t: {
  after(fn: () => void): void;
}): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(302, { location: "https://elsewhere.example/done" }).end();
  });
  t.after(() => server.close());
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, port: (server.address() as AddressInfo).port, hits }),
    ),
  );
}

describe("deliverCallback", () => {
  it("makes one request and does not follow the redirect", async (t) => {
    const { port, hits } = await listener(t);
    const r = await deliverCallback(new URL(`http://127.0.0.1:${port}/cb?code=abc&state=s`));
    assert.deepEqual(r, { delivered: true, status: 302 });
    assert.deepEqual(hits, ["/cb?code=abc&state=s"]);
  });

  it("reports a listener that is gone", async () => {
    const r = await deliverCallback(new URL("http://127.0.0.1:9/cb?code=abc&state=s"), 2_000);
    assert.equal(r.delivered, false);
  });
});

describe("kit mcp callback (real CLI)", () => {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [cli, "mcp", "callback", ...args], {
        env: { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_HIDE_HOOK_SKIP_BANNER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("close", (code) => done({ code, out }));
    });

  it("delivers to the listener and never prints the code", async (t) => {
    const { port, hits } = await listener(t);
    const auth = `https://mcp.example/authorize?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}&state=st4te`;
    const r = await run(["--for", auth, `http://127.0.0.1:${port}/cb?code=s3cretc0de&state=st4te`]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      new RegExp(`delivered the sign-in callback to 127\\.0\\.0\\.1:${port} \\(HTTP 302\\)`),
    );
    assert.equal(r.out.includes("s3cretc0de"), false);
    assert.equal(hits.length, 1);
  });

  it("refuses a callback of another sign-in without making a request", async (t) => {
    const { port, hits } = await listener(t);
    const auth = `https://mcp.example/authorize?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}&state=st4te`;
    const r = await run(["--for", auth, `http://127.0.0.1:${port}/cb?code=s3cretc0de&state=other`]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /not delivered: the address does not belong/);
    assert.equal(hits.length, 0);
  });
});

describe("the gates refuse it from an agent", () => {
  it("trailCommandRefusal names kit mcp callback, and leaves kit mcp list alone", () => {
    assert.match(
      trailCommandRefusal('kit mcp callback "http://localhost:1/cb?code=a&state=s"', "/h") ?? "",
      /authorization code/,
    );
    assert.equal(trailCommandRefusal("kit mcp list", "/h"), null);
  });
});
