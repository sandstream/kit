/** Exercise the guarded key publication window in a separate process. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getAuditAnchorKey } from "./audit-anchor.js";
import { privateFileIsControlled } from "./utils/secure-perms.js";

async function waitFor(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`key creator exited: ${child.exitCode ?? child.signalCode}`);
    if (Date.now() > deadline) throw new Error("key creator did not reach the publication barrier");
    await new Promise((done) => setTimeout(done, 20));
  }
}

it("keeps a secured key after the creator is killed between link and cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-anchor-process-"));
  const marker = join(root, "ready");
  const moduleUrl = new URL("./audit-anchor.js", import.meta.url).href;
  const script = `import {getAuditAnchorKey} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs'; let calls=0; const cell=new Int32Array(new SharedArrayBuffer(4)); await getAuditAnchorKey(process.argv[1], () => { calls++; if (calls===6) { writeFileSync(process.argv[2], 'ready'); while (true) Atomics.wait(cell, 0, 0, 1000); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, marker], {
    stdio: "ignore",
  });
  try {
    await waitFor(marker, child);
    const path = join(root, "audit-anchor.key");
    const temp = readdirSync(root).find((name) =>
      /^\.kit-audit-anchor-[a-f0-9]{32}\.tmp$/.test(name),
    );
    assert.ok(temp);
    const temporary = join(root, temp);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let legacyReader: Buffer;
    try {
      assert.equal(fstatSync(fd).ino, statSync(temporary).ino);
      assert.equal(fstatSync(fd).nlink, 2);
      assert.equal(privateFileIsControlled(path), true);
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
      assert.equal(child.signalCode, "SIGKILL");
      await assert.rejects(
        getAuditAnchorKey(root, () => {}),
        (error: Error) =>
          error.message.includes(path) &&
          error.message.includes(temporary) &&
          error.message.includes("Preserve both"),
      );
      legacyReader = await getAuditAnchorKey(root);
      assert.equal(legacyReader.toString("hex"), readFileSync(fd, "utf8").trim());
    } finally {
      closeSync(fd);
    }
    unlinkSync(temporary);
    assert.deepEqual(await getAuditAnchorKey(root, () => {}), legacyReader);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

it("waits for another process to finish publishing the key", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-anchor-process-"));
  const marker = join(root, "ready"),
    release = join(root, "release");
  const moduleUrl = new URL("./audit-anchor.js", import.meta.url).href;
  const script = `import {getAuditAnchorKey} from ${JSON.stringify(moduleUrl)}; import {writeFileSync,existsSync} from 'node:fs'; let calls=0; const cell=new Int32Array(new SharedArrayBuffer(4)); await getAuditAnchorKey(process.argv[1], () => { calls++; if (calls===6) { writeFileSync(process.argv[2], 'ready'); while (!existsSync(process.argv[3])) Atomics.wait(cell, 0, 0, 10); } });`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, root, marker, release],
    { stdio: "ignore" },
  );
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  try {
    await waitFor(marker, child);
    let settled = false;
    const reader = getAuditAnchorKey(root, () => {});
    void reader.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(settled, false);
    writeFileSync(release, "continue");
    const key = await reader;
    assert.equal(await exited, 0);
    assert.equal(key.toString("hex"), readFileSync(join(root, "audit-anchor.key"), "utf8").trim());
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
