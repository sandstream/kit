import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { startRuntimeStage } from "./runtime-stage-macos.js";

const skip = process.platform !== "darwin";

it("removes its staging executable on ordinary release", { skip }, () => {
  const stage = startRuntimeStage();
  try {
    stage.assertCurrent();
    writeFileSync(stage.executable, "fixture", { flag: "wx", mode: 0o600 });
  } finally {
    stage.release();
  }
  assert.equal(existsSync(dirname(stage.executable)), false);
});

function writePausedCopyProbe(file: string, marker: string, scratch: string): void {
  const subject = new URL("./sealed-candidate.js", import.meta.url);
  writeFileSync(
    file,
    [
      'import assert from "node:assert/strict";',
      'import { createHash } from "node:crypto";',
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const {withSealedRuntime} = await import(${JSON.stringify(subject.href)});`,
      "const open = fs.openSync; const write = fs.writeSync;",
      "let copyFd; let copyPath;",
      "fs.openSync = function(path, ...args) {",
      "  const fd = open.call(this, path, ...args);",
      `  if (typeof path === "string" && path.startsWith(${JSON.stringify(scratch + "/")}) && path.endsWith("/node")) { copyFd = fd; copyPath = path; }`,
      "  return fd;",
      "};",
      "fs.writeSync = function(fd, ...args) {",
      "  const n = write.call(this, fd, ...args);",
      "  if (fd === copyFd && n > 0) {",
      `    fs.writeFileSync(${JSON.stringify(marker)}, copyPath);`,
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      "  }",
      "  return n;",
      "};",
      "syncBuiltinESMExports();",
      "const runtime = fs.realpathSync(process.execPath);",
      'const digest = createHash("sha256").update(fs.readFileSync(runtime)).digest("hex");',
      'const result = withSealedRuntime(runtime, digest, () => { throw Error("unexpected launch"); });',
      "assert.fail(JSON.stringify(result));",
    ].join("\n"),
  );
}

it(
  "cleans an interrupted first Node copy and preserves a sibling directory",
  { skip },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-runtime-stage-test-")));
    const scratch = join(root, "scratch with spaces");
    const marker = join(root, "copied");
    const probe = join(root, "probe.mjs");
    mkdirSync(scratch);
    const sibling = join(scratch, "sibling");
    mkdirSync(sibling);
    const siblingFile = join(sibling, "node");
    writeFileSync(siblingFile, "keep");
    writePausedCopyProbe(probe, marker, scratch);
    const child = spawn(process.execPath, [probe], {
      cwd: root,
      env: { ...process.env, TMPDIR: scratch, KIT_READ_ONLY: "0" },
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    try {
      const waiting = AbortSignal.timeout(20_000);
      while (!existsSync(marker) && child.exitCode === null && child.signalCode === null)
        await pause(25, undefined, { signal: waiting });
      assert.ok(existsSync(marker), "The first Node copy did not start");
      const stages = readdirSync(scratch).filter((name) => name !== "sibling");
      assert.equal(stages.length, 1);
      const stage = join(scratch, stages[0]!);
      assert.ok(statSync(readFileSync(marker, "utf8")).size > 0);
      assert.equal(existsSync(join(stage, "candidate.dmg")), false);
      child.kill("SIGKILL");
      assert.deepEqual(await exited, [null, "SIGKILL"]);
      while (existsSync(stage)) await pause(25, undefined, { signal: waiting });
      assert.equal(statSync(siblingFile).size, 4);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rmTemp(root);
    }
  },
);
