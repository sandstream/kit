import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as nodeIt } from "node:test";
import { DesktopApp } from "./monkey-test-desktop-app.js";
import { shellQuote } from "./monkey-test-runner.test-support.js";

// The rig launches the fake app through a POSIX shell and relies on SIGTERM/SIGKILL semantics;
// Windows has neither, so these tests run on macOS and Linux only.
const it = (name: string, body: () => Promise<void>): Promise<void> =>
  nodeIt(name, { skip: process.platform === "win32" }, body);

const HOOK_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const hook = process.env.HOOK;
const mode = process.argv[2] || "echo";
setInterval(() => {
  const cmd = path.join(hook, "cmd.js");
  if (!fs.existsSync(cmd)) return;
  const body = fs.readFileSync(cmd, "utf8");
  fs.unlinkSync(cmd);
  const nonce = /"(kit-[^"]+:)"/.exec(body)[1];
  const out = path.join(hook, "out.txt");
  if (mode === "stale") fs.writeFileSync(out, "kit-old:" + JSON.stringify({ value: 0 }));
  else if (mode === "err") fs.writeFileSync(out, "ERR boom");
  else if (mode === "throw") fs.writeFileSync(out, nonce + JSON.stringify({ error: "bad body" }));
  else if (mode === "garbage") fs.writeFileSync(out, nonce + "{nope");
  else if (mode === "silent") return;
  else fs.writeFileSync(out, nonce + JSON.stringify({ value: 42 }));
}, 10);
`;

interface Rig {
  dir: string;
  hook: string;
  app: DesktopApp;
}

function rig(mode: string, command?: string): Rig {
  const dir = mkdtempSync(join(tmpdir(), "kit-desktop-app-"));
  const hook = join(dir, "hook");
  mkdirSync(hook);
  const script = join(dir, "fake.cjs");
  writeFileSync(script, HOOK_SCRIPT);
  const app = new DesktopApp({
    command: command ?? `${shellQuote(process.execPath)} ${shellQuote(script)} ${mode}`,
    cwd: dir,
    env: { ...process.env, HOOK: hook },
    hookDir: hook,
    logPath: join(dir, "app.log"),
  });
  return { dir, hook, app };
}

async function withApp(mode: string, run: (rigged: Rig) => Promise<void>): Promise<void> {
  const rigged = rig(mode);
  try {
    await run(rigged);
  } finally {
    await rigged.app.stop("SIGKILL", 500);
    rmSync(rigged.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

it("is not running before start, and eval reports the app exited", async () => {
  await withApp("echo", async ({ app }) => {
    assert.equal(app.running(), false);
    assert.equal(await app.stop("SIGTERM", 100), true);
    const result = await app.eval("return 1;", 500);
    assert.deepEqual(result, { ok: false, reason: "exited", message: "the app exited" });
  });
});

it("eval returns the value the app writes under the nonce", async () => {
  await withApp("echo", async ({ app }) => {
    app.start();
    assert.equal(app.running(), true);
    assert.deepEqual(await app.eval("return 42;", 5_000), { ok: true, value: 42 });
  });
});

it("eval maps a thrown body to an error result", async () => {
  await withApp("throw", async ({ app }) => {
    app.start();
    assert.deepEqual(await app.eval("throw new Error('x');", 5_000), {
      ok: false,
      reason: "error",
      message: "bad body",
    });
  });
});

it("eval returns ERR answers as errors", async () => {
  await withApp("err", async ({ app }) => {
    app.start();
    const result = await app.eval("return 1;", 5_000);
    assert.deepEqual(result, { ok: false, reason: "error", message: "ERR boom" });
  });
});

it("eval reports an unreadable answer", async () => {
  await withApp("garbage", async ({ app }) => {
    app.start();
    const result = await app.eval("return 1;", 5_000);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /unreadable answer/);
  });
});

it("eval ignores a stale answer and times out", async () => {
  await withApp("stale", async ({ app, hook }) => {
    app.start();
    const result = await app.eval("return 1;", 300);
    assert.deepEqual(result, { ok: false, reason: "timeout", message: "no answer within 300 ms" });
    assert.throws(() => readFileSync(join(hook, "out.txt")), /ENOENT/);
  });
});

it("eval times out when nobody answers and leaves no pending command", async () => {
  await withApp("silent", async ({ app, hook }) => {
    app.start();
    const result = await app.eval("return 1;", 200);
    assert.deepEqual(result, { ok: false, reason: "timeout", message: "no answer within 200 ms" });
    assert.throws(() => readFileSync(join(hook, "cmd.js")), /ENOENT/);
  });
});

it("newLog returns only text written since the last call", async () => {
  const rigged = rig("echo", `${shellQuote(process.execPath)} -e "console.log('hello-log')"`);
  try {
    rigged.app.start();
    assert.equal(await rigged.app.waitExit(5_000), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(rigged.app.newLog(), /hello-log/);
    assert.equal(rigged.app.newLog(), "");
    assert.match(readFileSync(join(rigged.dir, "app.log"), "utf8"), /hello-log/);
  } finally {
    rmSync(rigged.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it("stop terminates a running app and running turns false", async () => {
  await withApp("echo", async ({ app }) => {
    app.start();
    assert.equal(await app.stop("SIGTERM", 3_000), true);
    assert.equal(app.running(), false);
  });
});

it("stop escalates to SIGKILL when the app ignores SIGTERM", async () => {
  const stubborn = `${shellQuote(process.execPath)} -e "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"`;
  const rigged = rig("echo", stubborn);
  try {
    rigged.app.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await rigged.app.stop("SIGTERM", 200), true);
    assert.equal(rigged.app.running(), false);
  } finally {
    rmSync(rigged.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it("waitExit times out while the app keeps running", async () => {
  await withApp("echo", async ({ app }) => {
    app.start();
    assert.equal(await app.waitExit(100), false);
  });
});
