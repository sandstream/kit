import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import * as run from "./run.js";

it("redacts raw arguments with the effective command environment", async (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const fileSecret = 'file-\u00e5\u00e4\u00f6-"secret\\value';
  const overrideSecret = 'override-\u00e5\u00e4\u00f6-"secret\\value';
  writeFileSync(join(fixture.cwd, ".env.local"), `TEST_TOKEN=${fileSecret}\n`);
  const args = ["echo", fileSecret, overrideSecret, "public-value"] as const;
  assert.deepEqual(
    await run.redactArgumentsForEnvironment(args, fixture.cwd, {
      inheritEnv: false,
      envOverrides: { TEST_TOKEN: overrideSecret },
    }),
    ["echo", fileSecret, "[REDACTED]", "public-value"],
  );
  assert.deepEqual(await run.redactArgumentsForEnvironment(args, fixture.cwd), [
    "echo",
    "[REDACTED]",
    overrideSecret,
    "public-value",
  ]);
});

type RuntimeFixture = ReturnType<typeof createCliContractFixture>;

function writeSplitProgram(fixture: RuntimeFixture, bytes: Buffer, splitAt: number) {
  const release = join(fixture.cwd, "release");
  const pidFile = join(fixture.cwd, "child.pid");
  const resultFile = join(fixture.cwd, "result.json");
  const script = join(fixture.cwd, "split.cjs");
  writeFileSync(
    script,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const deadline = setTimeout(() => process.exit(2), 5000);
    const head = Buffer.from(${JSON.stringify([...bytes.subarray(0, splitAt)])});
    const tail = Buffer.from(${JSON.stringify([...bytes.subarray(splitAt)])});
    for (const fd of [1, 2]) fs.writeSync(fd, Buffer.concat([Buffer.from('READY\\n'), head]));
    const wait = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(wait);
      clearTimeout(deadline);
      for (const fd of [1, 2]) fs.writeSync(fd, tail);
    }, 10);
  `,
  );
  return { release, pidFile, resultFile, script };
}

async function withDeadline<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observeSplitOutput(child: ReturnType<typeof spawn>, release: string) {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const ready = { stdout: false, stderr: false };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]!.on("data", (chunk: Buffer) => {
      chunks[stream].push(chunk);
      ready[stream] = Buffer.concat(chunks[stream]).includes(Buffer.from("READY\n"));
      // The child waits until both first chunks were forwarded by executeCommand.
      // This forces an actual decode boundary without timing assumptions or mocks.
      if (ready.stdout && ready.stderr) writeFileSync(release, "go");
    });
  }
  return chunks;
}

function registerStreamCleanup(
  t: TestContext,
  state: {
    fixture: RuntimeFixture;
    child: ReturnType<typeof spawn>;
    closed: Promise<number | null>;
    pidFile: string;
  },
): void {
  const { fixture, child, closed, pidFile } = state;
  t.after(async () => {
    const parentRunning = child.exitCode === null && child.signalCode === null;
    if (parentRunning && existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (parentRunning) child.kill("SIGKILL");
    try {
      await withDeadline(closed, 2500, "stream fixture cleanup timed out");
    } finally {
      fixture.cleanup();
    }
  });
}

async function streamedRun(
  t: TestContext,
  bytes: Buffer,
  splitAt: number,
  secret?: string,
  maxOutputBytes = 4096,
) {
  const fixture = createCliContractFixture();
  const { release, pidFile, resultFile, script } = writeSplitProgram(fixture, bytes, splitAt);
  const source = import.meta.url.endsWith(".ts");
  const module = new URL(source ? "./run.ts" : "./run.js", import.meta.url).href;
  const opts: run.RunOptions = {
    commandArgs: [process.execPath, script],
    cwd: fixture.cwd,
    inheritEnv: false,
    envOverrides: secret ? { TEST_TOKEN: secret } : {},
    stdin: "ignore",
    timeoutMs: 3000,
    maxOutputBytes,
  };
  const child = spawn(
    process.execPath,
    [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      `import {writeFileSync} from 'node:fs';
     const {executeCommand} = await import(${JSON.stringify(module)});
     const result = await executeCommand(${JSON.stringify(opts)});
     writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));`,
    ],
    { cwd: fixture.cwd, env: fixture.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks = observeSplitOutput(child, release);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  registerStreamCleanup(t, { fixture, child, closed, pidFile });
  const code = await withDeadline(closed, 7000, "stream fixture exceeded its deadline");
  assert.equal(code, 0, Buffer.concat(chunks.stderr).toString());
  return {
    stdout: Buffer.concat(chunks.stdout).toString(),
    stderr: Buffer.concat(chunks.stderr).toString(),
    result: JSON.parse(readFileSync(resultFile, "utf8")) as run.RunResult,
  };
}

for (const [text, splitAt] of [
  ["\u00e5\n", 1],
  ["€\n", 2],
  ["😀\n", 3],
] as const) {
  it(`preserves split UTF-8 ${text.trim()} in captured and streamed output`, async (t) => {
    const output = await streamedRun(t, Buffer.from(text), splitAt);
    assert.equal(output.result.exitCode, 0);
    for (const stream of ["stdout", "stderr"] as const) {
      assert.equal(output[stream], `READY\n${text}`);
      assert.equal(output.result[stream], `READY\n${text}`);
    }
  });
}

it("redacts a known secret when its UTF-8 bytes cross output chunks", async (t) => {
  const secret = "fixture-\u00e5\u00e4\u00f6-😀-credential";
  const output = await streamedRun(t, Buffer.from(`${secret}\n`), 9, secret);
  for (const stream of ["stdout", "stderr"] as const) {
    assert.equal(output[stream], "READY\n[REDACTED]\n");
    assert.equal(output.result[stream], "READY\n[REDACTED]\n");
  }
});

it("omits a UTF-8 character cut by the byte limit", async (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const result = await run.executeCommand({
    commandArgs: [process.execPath, "-e", "require('node:fs').writeSync(1, 'A😀B')"],
    cwd: fixture.cwd,
    inheritEnv: false,
    stdin: "ignore",
    streamOutput: false,
    timeoutMs: 3000,
    maxOutputBytes: 3,
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, "A", "the byte cap must not manufacture a replacement character");
});

it("preserves complete UTF-8 at the exact byte limit and flushes an incomplete ordinary EOF", async (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  for (const [script, limit, expected] of [
    ["require('node:fs').writeSync(1, 'A😀B')", 6, "A😀B"],
    ["require('node:fs').writeSync(1, Buffer.from([0xc3]))", 64, "\ufffd"],
  ] as const) {
    const result = await run.executeCommand({
      commandArgs: [process.execPath, "-e", script],
      cwd: fixture.cwd,
      inheritEnv: false,
      stdin: "ignore",
      streamOutput: false,
      timeoutMs: 1000,
      maxOutputBytes: limit,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, undefined);
    assert.equal(result.stdout, expected);
  }
});
