import assert from "node:assert/strict";
import cp from "node:child_process";
import { once, setMaxListeners } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [, , mode, dist, project, id, delayMs] = process.argv;
const moduleAt = (file) => import(pathToFileURL(join(resolve(dist), file)));
const isIndex = (path) => basename(path).startsWith(".kit-audit-index-");
const isAnchorFile = (path) => basename(path).startsWith("audit-anchor");

if (mode === "worker") {
  const acl = [];
  const locks = [];
  const activeLocks = new WeakMap();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const track = (kind, call) => {
    const start = performance.now();
    try {
      return call();
    } finally {
      acl.push({ kind, ms: performance.now() - start });
    }
  };
  const chmod = fs.chmodSync;
  fs.chmodSync = (path, ...args) => {
    if (!isIndex(path)) return chmod(path, ...args);
    return track("synthetic-index-acl", () => {
      if (Number(delayMs)) Atomics.wait(signal, 0, 0, Number(delayMs));
      return chmod(path, ...args);
    });
  };
  const exec = cp.execFileSync;
  cp.execFileSync = (file, args, options) => {
    const path = options?.env?.KIT_PRIVATE_ACL_PATH;
    if (!path) return exec(file, args, options);
    const kind = isIndex(path) ? "index-acl" : isAnchorFile(path) ? "anchor-key-acl" : "other-acl";
    return track(kind, () => exec(file, args, options));
  };
  const begin = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const result = begin.call(this, sql);
    if (sql === "BEGIN IMMEDIATE") {
      const location = basename(this.location() ?? "");
      if (location.endsWith(".lock.sqlite")) {
        const kind = location.startsWith("audit-anchor") ? "anchor-index" : "audit-log";
        activeLocks.set(this, { kind, started: performance.now() });
      }
    }
    return result;
  };
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () {
    const active = activeLocks.get(this);
    if (active) {
      activeLocks.delete(this);
      locks.push({ kind: active.kind, ms: performance.now() - active.started });
    }
    return close.call(this);
  };
  syncBuiltinESMExports();
  const { appendAuditEventDirect, logAuditEvent } = await moduleAt("audit.js");
  const configured = {
    enabled: true, environment: "test", access: {}, agent: { id: "test", name: "Test" },
    audit: { enabled: true }, approval: {}, secrets: {}, revocation: {}, scan: {}, containment: {},
  };
  const ready = once(process, "message");
  process.send("ready");
  await ready;
  const events = [];
  for (const kind of ["direct", "governed"]) {
    const event = { operation: "probe." + kind + "." + id, environment: "test", success: true };
    const start = performance.now();
    const result = kind === "direct"
      ? await appendAuditEventDirect(event, { cwd: project })
      : await logAuditEvent(configured, event, { cwd: project });
    events.push({ kind, result, ms: Math.round(performance.now() - start) });
  }
  process.send({ events, acl, locks });
  process.disconnect();
} else {
  const { appendAuditEventDirect, verifyAuditChain } = await moduleAt("audit.js");
  const { readAnchorRecord, tryReadAuditAnchorKey, verifyAgainstAnchor } =
    await moduleAt("audit-anchor.js");
  const output = [];
  const savedEnvironment = { ...process.env };
  for (const [writers, delay, waitMs] of [[8, 0, 5000], [24, 400, 5000], [24, 400, 30000]]) {
    const workspace = await mkdtemp(join(tmpdir(), "kit-c6c5-probe-"));
    const children = [];
    try {
      const childEnv = {
        PATH: savedEnvironment.PATH, SystemRoot: savedEnvironment.SystemRoot,
        WINDIR: savedEnvironment.WINDIR, HOME: workspace, USERPROFILE: workspace,
        XDG_CONFIG_HOME: join(workspace, "config"), KIT_IDENTITY_DIR: join(workspace, "identity"),
        KIT_AUDIT_ANCHOR_DIR: join(workspace, "anchors"), KIT_AUDIT_ANCHOR: "1",
        KIT_KEYSTORE: "file",
        ...(waitMs === 5000 ? {} : { KIT_AUDIT_LOCK_WAIT_MS: String(waitMs) }),
      };
      delete process.env.KIT_AUDIT_LOCK_WAIT_MS;
      for (const [key, value] of Object.entries(childEnv)) {
        if (key.startsWith("KIT_") && value) process.env[key] = value;
      }
      assert.equal(await appendAuditEventDirect(
        { operation: "probe.seed", environment: "test", success: true }, { cwd: workspace },
      ), true);
      const reports = [];
      const deadline = AbortSignal.timeout(120_000);
      setMaxListeners(0, deadline);
      const windowsDelays = process.platform === "win32" ? 0 : delay;
      for (let index = 0; index < writers; index++) {
        const child = cp.fork(process.argv[1], [
          "worker", dist, workspace, String(index), String(windowsDelays),
        ], { env: childEnv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
        children.push({ child, done: once(child, "close") });
        const started = once(child, "message", { signal: deadline });
        reports.push(started.then(([value]) => assert.equal(value, "ready")));
        child.stderr.on("end", () => {
          child.timeoutCount = (stderr.match(/Timed out waiting for the audit lock/g) ?? []).length;
        });
      }
      await Promise.all(reports);
      const messages = children.map(({ child }) => once(child, "message", { signal: deadline }));
      for (const { child } of children) child.send("start");
      const results = (await Promise.all(messages)).map(([value]) => value);
      const exits = await Promise.all(children.map(({ done }) => done));
      const events = results.flatMap((result) => result.events);
      const locksTimedOut = children.reduce((sum, { child }) => sum + child.timeoutCount, 0);
      const path = join(workspace, ".kit-audit.jsonl");
      const content = await readFile(path, "utf8");
      const chain = verifyAuditChain(content);
      const seal = verifyAgainstAnchor(content, await readAnchorRecord(path), await tryReadAuditAnchorKey());
      const success = events.filter((event) => event.result).length;
      assert.deepEqual(chain, { ok: true, entries: success + 1 });
      const recorded = content.trimEnd().split("\n").map((line) => JSON.parse(line).operation);
      assert.equal(new Set(recorded).size, success + 1);
      assert.equal(seal.status, "anchored-ok");
      assert.equal(seal.newSinceAnchor, 0);
      assert.equal(locksTimedOut, events.length - success);
      assert.equal(exits.every(([code]) => code === 0), locksTimedOut === 0);
      const summarize = (records) => records.reduce((a, { kind, ms }) => {
        a[kind] ??= { calls: 0, totalMs: 0, maxMs: 0 };
        a[kind].calls++;
        a[kind].totalMs += Math.round(ms);
        a[kind].maxMs = Math.max(a[kind].maxMs, Math.round(ms));
        return a;
      }, {});
      output.push({ writers, delayMs: windowsDelays, waitMs, success, locksTimedOut, chain, seal,
        maxAppendMs: Math.max(...events.map((entry) => entry.ms)),
        acl: summarize(results.flatMap((result) => result.acl)),
        locks: summarize(results.flatMap((result) => result.locks)) });
    } finally {
      for (const { child, done } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await done;
      }
      for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnvironment, key)) delete process.env[key];
      Object.assign(process.env, savedEnvironment);
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  console.log(JSON.stringify({ platform: process.platform, output }, null, 2));
}
