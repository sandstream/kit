import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runExternalProtocol } from "./audit-external-process.js";
import {
  assertStopped,
  fixture,
  quote,
  trackedPid,
} from "./audit-external-process.test-support.js";

function environment(t: TestContext, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

test("sends hostile receipt text literally through stdin and returns complete stdout", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "injected");
  const input = {
    receipt: `$(touch '${marker}')\n\`touch '${marker}'\`\n'; touch '${marker}'; # & echo bad`,
    text: "café 🔒",
  };
  const output = await runExternalProtocol(f.command("process.stdin.pipe(process.stdout);"), input);
  assert.equal(output, JSON.stringify(input));
  assert.equal(existsSync(marker), false);
});

test("isolates cwd and environment and derives compatibility values from the statement", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "node-options-loaded");
  const preload = join(f.root, "preload.cjs");
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  environment(t, {
    NODE_OPTIONS: `--require=${preload}`,
    KIT_ANCHOR_TIP: "inherited-tip",
    KIT_ANCHOR_COUNT: "999",
    KIT_ANCHOR_LOGPATH: "inherited-path",
    KIT_HOME: f.root,
    KIT_EXTERNAL_ANCHOR_CMD: "inherited-command",
    AUDIT_PRIVATE_SECRET: "do-not-inherit",
    BASH_ENV: preload,
    ENV: preload,
    ComSpec: preload,
  });
  const statement = { tip: "a".repeat(64), count: 7, logPath: `$(touch '${marker}'); 'log'` };
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(f.root);
  const output = await runExternalProtocol(
    f.command(`process.stdin.resume(); process.stdin.on('end', () => {
      console.log(JSON.stringify({cwd: process.cwd(), env: process.env}));
    });`),
    { statement },
  );
  const actual = JSON.parse(output);
  assert.equal(realpathSync(actual.cwd), realpathSync(homedir()));
  assert.equal(actual.env.KIT_ANCHOR_TIP, statement.tip);
  assert.equal(actual.env.KIT_ANCHOR_COUNT, "7");
  assert.equal(actual.env.KIT_ANCHOR_LOGPATH, statement.logPath);
  for (const key of [
    "NODE_OPTIONS",
    "KIT_HOME",
    "KIT_EXTERNAL_ANCHOR_CMD",
    "AUDIT_PRIVATE_SECRET",
    "BASH_ENV",
    "ENV",
    "ComSpec",
  ]) {
    assert.equal(actual.env[key], undefined, key);
  }
  assert.equal(existsSync(marker), false);
});

test("refuses input beyond one MiB of UTF-8 JSON before the command has effects", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "started");
  const command = f.command(
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); process.stdin.resume();`,
  );
  await assert.rejects(runExternalProtocol(command, "é".repeat(524_288)), /input.*limit/i);
  assert.equal(existsSync(marker), false);
});

test("refuses combined stdout and stderr overflow even when the command exits zero", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runExternalProtocol(
      f.command(`process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write('12345678'); process.stderr.write('private-stderr');
    });`),
      {},
      { maxOutputBytes: 16 },
    ),
    (error: Error) => {
      assert.match(error.message, /output.*limit/i);
      assert.doesNotMatch(error.stack ?? "", /private-stderr|12345678/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("preserves the legacy primitive statement without proof schema validation", async (t) => {
  const f = fixture(t);
  environment(t, {
    KIT_EXTERNAL_ANCHOR_CMD: "private-issuer-command",
    KIT_EXTERNAL_VERIFY_CMD: "private-verifier-command",
  });
  const output = await runExternalProtocol(
    f.command(`process.stdin.resume(); process.stdin.on('end', () => {
      console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('KIT_')))));
    });`),
    { statement: { tip: "deadbeef", count: 3, logPath: "/x" } },
  );
  assert.deepEqual(JSON.parse(output), {
    KIT_ANCHOR_TIP: "deadbeef",
    KIT_ANCHOR_COUNT: "3",
    KIT_ANCHOR_LOGPATH: "/x",
  });
});

test("does not derive compatibility variables from the receipt or inherited environment", async (t) => {
  const f = fixture(t);
  environment(t, { KIT_ANCHOR_TIP: "bad", KIT_ANCHOR_COUNT: "999", KIT_ANCHOR_LOGPATH: "bad" });
  const output = await runExternalProtocol(
    f.command(`process.stdin.resume(); process.stdin.on('end', () => {
      console.log(JSON.stringify(Object.keys(process.env).filter(key => key.startsWith('KIT_'))));
    });`),
    { receipt: { statement: { tip: "receipt-tip", count: 5, logPath: "/receipt" } } },
  );
  assert.deepEqual(JSON.parse(output), []);
});

test("derives compatibility values from the same JSON snapshot that reaches stdin", async (t) => {
  const f = fixture(t);
  const output = await runExternalProtocol(
    f.command(`let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
      console.log(JSON.stringify({input: JSON.parse(input), tip: process.env.KIT_ANCHOR_TIP}));
    });`),
    {
      statement: { tip: "before", count: 1, logPath: "/before" },
      toJSON: () => ({ statement: { tip: "serialized", count: 2, logPath: "/after" } }),
    },
  );
  assert.deepEqual(JSON.parse(output), {
    input: { statement: { tip: "serialized", count: 2, logPath: "/after" } },
    tip: "serialized",
  });
});

test("refuses invalid primitive statements before command effects", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "started");
  const command = f.command(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  for (const statement of [
    null,
    [],
    {},
    { tip: 7, count: 3, logPath: "/x" },
    { tip: "deadbeef", count: "3", logPath: "/x" },
    { tip: "deadbeef", count: 3, logPath: {} },
    { tip: "deadbeef\0", count: 3, logPath: "/x" },
    { tip: "deadbeef", count: 3, logPath: "/x\0" },
  ]) {
    await assert.rejects(runExternalProtocol(command, { statement }), /statement.*invalid/i);
  }
  assert.equal(existsSync(marker), false);
});

test("rejects unserializable input without exposing its error or starting the command", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "started");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const command = f.command(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  for (const input of [
    undefined,
    1n,
    cyclic,
    {
      toJSON() {
        throw new Error("private-input-secret");
      },
    },
  ]) {
    await assert.rejects(runExternalProtocol(command, input), (error: Error) => {
      assert.match(error.message, /input.*JSON/i);
      assert.doesNotMatch(error.stack ?? "", /private-input-secret/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(existsSync(marker), false);
});

test("accepts exactly one MiB of serialized input", async (t) => {
  const f = fixture(t);
  const output = await runExternalProtocol(
    f.command(
      `let bytes = 0; process.stdin.on('data', c => bytes += c.length); process.stdin.on('end', () => console.log(bytes));`,
    ),
    "x".repeat(1_048_574),
  );
  assert.equal(output, "1048576\n");
});

test("preserves complete stdout at the default one MiB limit", async (t) => {
  const f = fixture(t);
  const output = await runExternalProtocol(
    f.command(
      `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(1048576)));`,
    ),
    null,
  );
  assert.equal(output, "x".repeat(1_048_576));
});

for (const stream of ["stdout", "stderr"]) {
  test(`refuses ${stream} above the default byte limit`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      runExternalProtocol(
        f.command(
          `process.stdin.resume(); process.stdin.on('end', () => process.${stream}.write('x'.repeat(1048577)));`,
        ),
        {},
      ),
      /output.*limit/i,
    );
  });
}

test("counts UTF-8 bytes and preserves characters split across writes", async (t) => {
  const f = fixture(t);
  const command = f.command(`process.stdin.resume(); process.stdin.on('end', () => {
    const bytes = Buffer.from('é🔒'); process.stdout.write(bytes.subarray(0, 3));
    setTimeout(() => process.stdout.write(bytes.subarray(3)), 30);
  });`);
  assert.equal(await runExternalProtocol(command, {}, { maxOutputBytes: 6 }), "é🔒");
  await assert.rejects(runExternalProtocol(command, {}, { maxOutputBytes: 5 }), /output.*limit/i);
});

test("rejects incomplete UTF-8 instead of returning substituted output", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runExternalProtocol(
      f.command(
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.from([0xf0, 0x9f])));`,
      ),
      {},
    ),
    /UTF-8/,
  );
});

test("returns only stdout after a zero exit with bounded stderr", async (t) => {
  const f = fixture(t);
  assert.equal(
    await runExternalProtocol(
      f.command(`process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write('receipt\\n'); process.stderr.write('private diagnostic');
    });`),
      {},
    ),
    "receipt\n",
  );
});

test("refuses a nonzero exit without exposing stdout, stderr, or the operator command", async (t) => {
  const f = fixture(t);
  const command = f.command(`process.stdin.resume(); process.stdin.on('end', () => {
    process.stdout.write('private-proof'); process.stderr.write('private-secret'); process.exitCode = 7;
  });`);
  await assert.rejects(runExternalProtocol(command, {}), (error: Error) => {
    assert.match(error.message, /nonzero/i);
    assert.doesNotMatch(error.stack ?? "", /private-proof|private-secret|command-0.cjs/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("refuses an actual spawn error without exposing its path", async (t) => {
  const f = fixture(t);
  environment(t, {
    HOME: join(f.root, "missing-private-home"),
    USERPROFILE: join(f.root, "missing-private-home"),
  });
  await assert.rejects(
    runExternalProtocol(f.command("process.stdin.resume();"), {}),
    (error: Error) => {
      assert.match(error.message, /could not start/i);
      assert.doesNotMatch(error.stack ?? "", /missing-private-home/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("refuses a missing executable", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runExternalProtocol(quote(join(f.root, "missing-command")), {}),
    /nonzero|stdin/i,
  );
});

test("rejects invalid options and commands before command effects", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "started");
  const command = f.command(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(runExternalProtocol(command, {}, { timeoutMs }), /timeout/i);
  }
  for (const maxOutputBytes of [0, -1, 0.5, NaN, Infinity, 1_048_577]) {
    await assert.rejects(runExternalProtocol(command, {}, { maxOutputBytes }), /limit/i);
  }
  for (const invalid of ["", " ", "private\0command"]) {
    await assert.rejects(runExternalProtocol(invalid, {}), /command.*invalid/i);
  }
  assert.equal(existsSync(marker), false);
});

test("refuses stdin failure and stops the command", async (t) => {
  const f = fixture(t);
  const pidPath = join(f.root, "command.pid");
  const pid = trackedPid(pidPath);
  const command = f.command(`const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); fs.closeSync(0);
    process.stdout.write('looks-valid'); setInterval(() => {}, 1000);
  `);
  // The command runs through a shell. When the shell keeps its own handle to the stdin pipe
  // (cmd.exe, and sh on the Linux CI runner), the pipe stays open after the command closes it:
  // the write stalls and the timeout refuses the command instead of a write error. Either way
  // the output is refused and the command is stopped.
  await assert.rejects(
    runExternalProtocol(command, "x".repeat(900_000), { timeoutMs: 3_000 }),
    /stdin|timeout/i,
  );
  await assertStopped(pid());
});

test(
  "refuses a signal exit even after output",
  { skip: process.platform === "win32" ? "POSIX signal exit" : false },
  async (t) => {
    const f = fixture(t);
    await assert.rejects(
      runExternalProtocol(
        f.command(`process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write('looks-valid'); process.kill(process.pid, 'SIGKILL');
    });`),
        {},
      ),
      /signal|nonzero/i,
    );
  },
);

for (const mode of ["timeout", "overflow", "nonzero", "inherited-pipes", "closed-pipes"] as const) {
  test(
    `cleans up a real child tree on ${mode}`,
    {
      skip:
        process.platform === "win32" && (mode === "closed-pipes" || mode === "inherited-pipes")
          ? "Windows taskkill cannot enumerate descendants after parent exit; native Job Object support is outside this adapter"
          : false,
    },
    async (t) => {
      const f = fixture(t);
      const parentPath = join(f.root, "parent.pid");
      const childPath = join(f.root, "child.pid");
      const heartbeat = join(f.root, "heartbeat");
      const parentPid = trackedPid(parentPath);
      const childPid = trackedPid(childPath);
      const descendant = `const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(childPath)}, String(process.pid));
      fs.writeFileSync(${JSON.stringify(heartbeat)}, 'ready');
      process.send('ready');
      setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);
    `;
      const action =
        mode === "timeout"
          ? "setInterval(() => {}, 1000);"
          : mode === "overflow"
            ? "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);"
            : mode === "nonzero"
              ? "process.exit(7);"
              : "process.stdout.write('looks-valid'); process.exit(0);";
      const command =
        f.command(`const fs = require('node:fs'); const {spawn} = require('node:child_process');
      process.on('SIGTERM', () => {}); process.stdin.resume();
      fs.writeFileSync(${JSON.stringify(parentPath)}, String(process.pid));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', ${mode === "closed-pipes" ? "'ignore', 'ignore'" : "1, 2"}, 'ipc'],
      });
      child.once('message', () => { child.disconnect(); ${action} });
    `);
      const start = Date.now();
      await assert.rejects(
        runExternalProtocol(command, {}, { timeoutMs: 700, maxOutputBytes: 1024 }),
        mode === "timeout"
          ? /timeout/i
          : mode === "overflow"
            ? /output.*limit/i
            : mode === "nonzero"
              ? /nonzero/i
              : /lingering children/i,
      );
      assert.ok(Date.now() - start < 3_000, "command and cleanup must be bounded");
      if (mode === "timeout") assert.ok(Date.now() - start >= 600, "must exercise the timeout");
      await assertStopped(parentPid());
      await assertStopped(childPid());
      const stopped = readFileSync(heartbeat, "utf8");
      await delay(50);
      assert.equal(readFileSync(heartbeat, "utf8"), stopped, "descendant effects must stop");
    },
  );
}
