import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { checkRevocationStatus, forceRevocationCheck } from "./revocation.js";
import { runGoverned } from "./governance-middleware.js";
import type { GovernanceConfig } from "./config.js";

async function endpoint(
  t: TestContext,
  verdict: (path: string) => boolean | number | Promise<boolean | number>,
) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    const result = await verdict(path);
    response.writeHead(typeof result === "number" ? result : 200, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ revoked: result }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/agents/{agent_id}`, requests };
}

function config(endpoint: string, id: string): GovernanceConfig {
  return {
    enabled: true,
    agent: { id },
    revocation: { enabled: true, revocation_endpoint: endpoint, check_interval: 300 },
  };
}

it("an allowed agent cannot supply the cached verdict for a revoked agent", async (t) => {
  const remote = await endpoint(t, (path) => path === "/agents/revoked-agent");
  const allowed = config(remote.url, "allowed-agent");
  const revoked = config(remote.url, "revoked-agent");
  assert.equal((await forceRevocationCheck(allowed)).revoked, false);
  const cachedVerdict = await checkRevocationStatus(revoked);
  assert.equal((await forceRevocationCheck(revoked)).revoked, true);
  assert.equal(cachedVerdict, true);
  assert.deepEqual(remote.requests, [
    "/agents/allowed-agent",
    "/agents/revoked-agent",
    "/agents/revoked-agent",
  ]);
});

it("an older allowed response cannot replace a newer revoked response", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  t.after(() => release());
  let count = 0;
  const remote = await endpoint(t, async () => {
    if (++count === 1) {
      arrived();
      await held;
      return false;
    }
    return true;
  });
  const cfg = config(remote.url, "concurrent-agent");
  const older = forceRevocationCheck(cfg);
  await firstRequest;
  assert.equal((await forceRevocationCheck(cfg)).revoked, true);
  release();
  assert.equal((await older).revoked, true);
  assert.equal(await checkRevocationStatus(cfg), true);
  assert.equal(remote.requests.length, 2);
});

it("a completed intermediate refresh cannot hide a later denial from an older request", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  t.after(() => release());
  let count = 0;
  const remote = await endpoint(t, async () => {
    const request = ++count;
    if (request === 1) {
      arrived();
      await held;
    }
    return request >= 3;
  });
  const cfg = config(remote.url, "three-refresh-agent");
  const older = forceRevocationCheck(cfg);
  await firstRequest;
  assert.equal((await forceRevocationCheck(cfg)).revoked, false);
  assert.equal((await forceRevocationCheck(cfg)).revoked, true);
  release();
  assert.equal((await older).revoked, true);
  assert.equal(await checkRevocationStatus(cfg), true);
  assert.equal(remote.requests.length, 3);
});

it("a failed forced refresh invalidates permission until the endpoint recovers", async (t) => {
  let result: boolean | number = false;
  const remote = await endpoint(t, () => result);
  const cfg = config(remote.url, "recovering-agent");
  assert.equal(await checkRevocationStatus(cfg), false);
  result = 503;
  assert.equal((await forceRevocationCheck(cfg)).revoked, true);
  assert.equal(await checkRevocationStatus(cfg), true);
  assert.equal(remote.requests.length, 3);
  result = false;
  assert.equal(await checkRevocationStatus(cfg), false);
  assert.equal(await checkRevocationStatus(cfg), false);
  assert.equal(remote.requests.length, 4);
});

it("a different authority cannot reuse an allowed result for the same agent", async (t) => {
  const allowed = await endpoint(t, () => false);
  const denied = await endpoint(t, () => true);
  assert.equal((await forceRevocationCheck(config(allowed.url, "same-agent"))).revoked, false);
  assert.equal(await checkRevocationStatus(config(denied.url, "same-agent")), true);
  assert.deepEqual(denied.requests, ["/agents/same-agent"]);
});

it("a caller cannot change the cached verdict through a returned status object", async (t) => {
  const remote = await endpoint(t, () => true);
  const cfg = config(remote.url, "revoked-agent");
  const status = await forceRevocationCheck(cfg);
  assert.equal(status.revoked, true);
  status.revoked = false;
  assert.equal(await checkRevocationStatus(cfg), true);
  assert.equal(remote.requests.length, 1);
});

it("a zero check interval checks the endpoint before each operation", async (t) => {
  let revoked = false;
  const remote = await endpoint(t, () => revoked);
  const cfg = config(remote.url, "uncached-agent");
  cfg.revocation!.check_interval = 0;
  assert.equal(await checkRevocationStatus(cfg), false);
  revoked = true;
  assert.equal(await checkRevocationStatus(cfg), true);
  assert.equal(remote.requests.length, 2);
});

it("a backwards wall-clock change cannot extend a cached permission", async (t) => {
  let revoked = false;
  const remote = await endpoint(t, () => revoked);
  const cfg = config(remote.url, "clock-agent");
  cfg.revocation!.check_interval = 0.01;
  assert.equal((await forceRevocationCheck(cfg)).revoked, false);
  const previousTime = Date.now() - 86_400_000;
  t.mock.method(Date, "now", () => previousTime);
  revoked = true;
  await delay(30);
  assert.equal(await checkRevocationStatus(cfg), true);
  assert.equal(remote.requests.length, 2);
});

it("project aliases share permission invalidation and recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kit-revocation-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  const cwd = await realpath(join(root, "project"));
  const alias = join(root, "alias");
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  let result: boolean | number = false;
  const remote = await endpoint(t, () => result);
  const cfg = config(remote.url, "aliased-agent");
  assert.equal((await forceRevocationCheck(cfg, { cwd })).revoked, false);
  result = 503;
  assert.equal((await forceRevocationCheck(cfg, { cwd: alias })).revoked, true);
  assert.equal(await checkRevocationStatus(cfg, { cwd }), true);
  assert.equal(remote.requests.length, 3);
  result = false;
  assert.equal(await checkRevocationStatus(cfg, { cwd: alias }), false);
  assert.equal(await checkRevocationStatus(cfg, { cwd }), false);
  assert.equal(remote.requests.length, 4);
});

it("an unverifiable project directory denies access until the directory exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kit-revocation-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "missing");
  const remote = await endpoint(t, () => false);
  const cfg = config(remote.url, "directory-agent");
  assert.equal((await forceRevocationCheck(cfg, { cwd })).revoked, true);
  assert.equal(await checkRevocationStatus(cfg, { cwd }), true);
  assert.equal(remote.requests.length, 0);
  await mkdir(cwd);
  assert.equal(await checkRevocationStatus(cfg, { cwd }), false);
  assert.equal(remote.requests.length, 1);
});

it("repeated checks reuse a verified result only for the same authority and agent", async (t) => {
  const remote = await endpoint(t, () => false);
  const cfg = config(remote.url, "same-agent");
  assert.equal(await checkRevocationStatus(cfg), false);
  assert.equal(await checkRevocationStatus(cfg), false);
  assert.deepEqual(remote.requests, ["/agents/same-agent"]);
  assert.equal(await checkRevocationStatus({ ...cfg, agent: {} }), true);
  assert.equal(await checkRevocationStatus({ ...cfg, revocation: { enabled: true } }), true);
  assert.deepEqual(remote.requests, ["/agents/same-agent"]);
});

it("a target project gets its own revocation check before a governed write", async (t) => {
  const projects = await Promise.all([
    mkdtemp(join(tmpdir(), "kit-revocation-allowed-")),
    mkdtemp(join(tmpdir(), "kit-revocation-denied-")),
  ]);
  t.after(() => Promise.all(projects.map((cwd) => rm(cwd, { recursive: true, force: true }))));
  let revoked = false;
  const remote = await endpoint(t, () => revoked);
  const cfg = {
    governance: {
      ...config(remote.url, "same-agent"),
      environment: "dev" as const,
      audit: { enabled: false },
      secrets: { check_expiration: false },
    },
  };
  const operation = { operation: "write-proof", operationType: "write" as const };
  const write = (cwd: string) =>
    runGoverned(cfg, operation, () => writeFile(join(cwd, "effect.txt"), "written"), { cwd });
  assert.equal((await write(projects[0])).ok, true);
  assert.equal(await readFile(join(projects[0], "effect.txt"), "utf8"), "written");
  revoked = true;
  assert.equal((await write(projects[1])).ok, false);
  assert.deepEqual(await readdir(projects[1]), []);
  assert.deepEqual(remote.requests, ["/agents/same-agent", "/agents/same-agent"]);
});
