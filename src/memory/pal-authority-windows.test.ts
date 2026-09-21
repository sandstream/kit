import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { palAdd, palAutoVerify, palList } from "./pal.js";
import { fixture as filesFixture } from "./backup.test-support.js";

function fixture(t: TestContext) {
  const files = filesFixture(t);
  const previousDir = process.env.KIT_MEMORY_DIR;
  const previousDevice = process.env.KIT_DEVICE_ID;
  process.env.KIT_MEMORY_DIR = files.dir;
  process.env.KIT_DEVICE_ID = "windows-authority-fixture";
  t.after(() => {
    if (previousDir === undefined) delete process.env.KIT_MEMORY_DIR;
    else process.env.KIT_MEMORY_DIR = previousDir;
    if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previousDevice;
  });
  return files;
}

function simulateWindows(t: TestContext): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
}

it(
  "Windows disk approval uses an owner-only ACL adapter",
  { skip: process.platform === "win32" },
  async (t) => {
    const { src, dir, track } = fixture(t);
    const powershell = join(dir, "Windows", "System32", "WindowsPowerShell", "v1.0");
    mkdirSync(powershell, { recursive: true });
    const executable = join(powershell, "powershell.exe");
    writeFileSync(executable, "#!/bin/sh\nprintf PRIVATE", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const previousRoot = process.env.SystemRoot;
    process.env.SystemRoot = join(dir, "Windows");
    t.after(() => {
      if (previousRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousRoot;
    });

    const db = track(openMemoryDb(src));
    simulateWindows(t);
    const id = palAdd(db, {
      title: "Windows-approved task",
      check: { type: "file-exists", path: src },
    });
    assert.equal((await palAutoVerify(db, 1)).checked, 1);
    assert.equal(palList(db, { status: "closed", readOnly: true })[0]?.id, id);
    assert.equal(existsSync(join(dir, ".kit-verifier-grants")), true);
  },
);

it(
  "native Windows disk approval roundtrips with verified ACLs",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { src, dir, track } = fixture(t);
    const db = track(openMemoryDb(src));
    const id = palAdd(db, {
      title: "native Windows-approved task",
      check: { type: "file-exists", path: src },
    });
    assert.equal((await palAutoVerify(db, 1)).checked, 1);
    assert.equal(palList(db, { status: "closed", readOnly: true })[0]?.id, id);
    assert.equal(existsSync(join(dir, ".kit-verifier-grants")), true);
  },
);

it(
  "a POSIX disk approval cannot execute after switching to native Windows",
  { skip: process.platform === "win32" },
  async (t) => {
    const { src, track } = fixture(t);
    const db = track(openMemoryDb(src));
    palAdd(db, { title: "POSIX approval", check: { type: "file-exists", path: src } });
    const before = palList(db, { readOnly: true });
    simulateWindows(t);
    const result = await palAutoVerify(db, 1);
    assert.equal(result.checked, 0);
    assert.equal(result.unverified[0]?.reason, "no-local-approval");
    assert.deepEqual(palList(db, { readOnly: true }), before);
  },
);

it("native Windows in-memory approvals remain confined to their connection", async (t) => {
  const { src, track } = fixture(t);
  const source = track(openMemoryDb(":memory:"));
  const target = track(openMemoryDb(":memory:"));
  simulateWindows(t);
  const id = palAdd(source, {
    title: "connection-local approval",
    check: { type: "file-exists", path: src },
  });
  const [action] = palList(source, { readOnly: true });
  source.prepare("VACUUM INTO ?").run(src);
  mergeDb(target, src);
  assert.equal(palList(target, { allDevices: true, readOnly: true })[0]?.sync_id, action.sync_id);
  // Copy the local approval fields as a database owner could; the other connection must refuse them.
  target
    .prepare(`UPDATE pending_actions SET kind=?, verify_definition=?, verify_grant=? WHERE id=?`)
    .run(action.kind, action.verify_check, action.verify_grant!, id);
  assert.equal((await palAutoVerify(source, 1)).checked, 1);
  const result = await palAutoVerify(target, 1);
  assert.equal(result.checked, 0);
  assert.equal(result.unverified[0]?.reason, "no-local-approval");
});
