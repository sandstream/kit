import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withBudgetLock } from "./budget-lock.js";

const LOCK_FILE = ".kit-budget-lock.sqlite";
const moduleUrl = new URL("./budget-lock.js", import.meta.url).href;

interface Worker {
  child: ChildProcess;
  done: Promise<void>;
  wait: (message: string) => Promise<void>;
  finish: () => Promise<void>;
  messages: string[];
}

function fixture(t: TestContext): { cwd: string; workers: Worker[] } {
  const cwd = mkdtempSync(join(tmpdir(), "kit-budget-lock-"));
  const workers: Worker[] = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
      }
      await worker.done;
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, workers };
}

function startWorker(context: ReturnType<typeof fixture>, body: string): Worker {
  const source = `
    import { withBudgetLock } from ${JSON.stringify(moduleUrl)};
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const cwd = process.argv[1];
    const signal = (message) => process.send(message);
    const next = () => new Promise((resolve) => process.once("message", resolve));
    const start = next();
    signal("ready");
    await start;
    try {
      ${body}
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source, context.cwd],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], env: process.env },
  );
  const messages: string[] = [];
  let stderr = "";
  let ended = false;
  child.on("message", (message) => messages.push(String(message)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  child.on("error", (error) => (stderr += error.message));
  const done = new Promise<void>((resolve) =>
    child.once("close", () => {
      ended = true;
      resolve();
    }),
  );
  const worker: Worker = {
    child,
    done,
    messages,
    wait: async (message) => {
      const deadline = performance.now() + 10000;
      while (!messages.includes(message)) {
        assert.ok(!ended, `Child exited before ${message}: ${stderr}`);
        assert.ok(performance.now() < deadline, `Child did not report ${message}: ${stderr}`);
        await delay(10);
      }
    },
    finish: async () => {
      await done;
      assert.equal(child.exitCode, 0, stderr);
    },
  };
  context.workers.push(worker);
  return worker;
}

async function startHolder(context: ReturnType<typeof fixture>): Promise<Worker> {
  const worker = startWorker(
    context,
    `
    await withBudgetLock(cwd, async () => {
      const release = next();
      signal("acquired");
      await release;
    });
  `,
  );
  await worker.wait("ready");
  worker.child.send("start");
  await worker.wait("acquired");
  return worker;
}

test("returns the callback value and retains a private regular database inode", async (t) => {
  const { cwd } = fixture(t);
  const value = { booked: true };
  assert.equal(await withBudgetLock(cwd, async () => value), value);
  const first = lstatSync(join(cwd, LOCK_FILE), { bigint: true });
  assert.ok(first.isFile());
  assert.equal(first.nlink, 1n);
  assert.notEqual(first.ino, 0n);
  if (process.platform !== "win32") assert.equal(first.mode & 0o777n, 0o600n);
  await withBudgetLock(cwd, async () => undefined);
  const second = lstatSync(join(cwd, LOCK_FILE), { bigint: true });
  assert.equal(second.ino, first.ino);
  assert.equal(second.dev, first.dev);
});

test("serializes asynchronous callers in the same process", { timeout: 10000 }, async (t) => {
  const { cwd } = fixture(t);
  let count = 0;
  let active = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withBudgetLock(cwd, async () => {
        assert.equal(active++, 0);
        const before = count;
        await delay(5);
        count = before + 1;
        assert.equal(--active, 0);
      }),
    ),
  );
  assert.equal(count, 12);
});

test("different project directories have independent locks", async (t) => {
  const { cwd } = fixture(t);
  const other = join(cwd, "other");
  mkdirSync(other);
  await withBudgetLock(cwd, async () => {
    assert.equal(await withBudgetLock(other, async () => 42), 42);
  });
});

test("preserves callback exceptions and permits a later independent process", async (t) => {
  const context = fixture(t);
  const expected = new Error("callback failure");
  // A callback error that resembles a SQLite lock error must never replay the callback.
  Object.assign(expected, { code: "ERR_SQLITE_ERROR", errcode: 5 });
  let calls = 0;
  await assert.rejects(
    withBudgetLock(context.cwd, async () => {
      calls++;
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.equal(calls, 1);
  const worker = startWorker(context, `await withBudgetLock(cwd, async () => signal("acquired"));`);
  await worker.wait("ready");
  worker.child.send("start");
  await worker.wait("acquired");
  await worker.finish();
});

test(
  "serializes read-modify-write across independent processes from first creation",
  { timeout: 15000 },
  async (t) => {
    const context = fixture(t);
    const counter = join(context.cwd, "counter");
    writeFileSync(counter, "0");
    const workers = Array.from({ length: 4 }, () =>
      startWorker(
        context,
        `
    for (let index = 0; index < 8; index++) {
      await withBudgetLock(cwd, async () => {
        const file = join(cwd, "counter");
        const count = Number(readFileSync(file, "utf8"));
        await delay(5);
        writeFileSync(file, String(count + 1));
      });
    }
    signal("complete");
  `,
      ),
    );
    await Promise.all(workers.map((worker) => worker.wait("ready")));
    for (const worker of workers) worker.child.send("start");
    await Promise.all(workers.map((worker) => worker.finish()));
    assert.equal(readFileSync(counter, "utf8"), "32");
  },
);

test("a waiting child acquires after normal release without replacing the database", async (t) => {
  const context = fixture(t);
  const holder = await startHolder(context);
  const inode = lstatSync(join(context.cwd, LOCK_FILE), { bigint: true }).ino;
  const waiter = startWorker(
    context,
    `
    signal("attempting");
    await withBudgetLock(cwd, async () => signal("acquired"));
  `,
  );
  await waiter.wait("ready");
  waiter.child.send("start");
  await waiter.wait("attempting");
  await delay(100);
  assert.ok(!waiter.messages.includes("acquired"));
  holder.child.send("release");
  await waiter.wait("acquired");
  await Promise.all([holder.finish(), waiter.finish()]);
  assert.equal(lstatSync(join(context.cwd, LOCK_FILE), { bigint: true }).ino, inode);
});

test(
  "SIGKILL releases the native lock while a child waits on the same inode",
  {
    skip: process.platform === "win32" ? "Requires POSIX SIGKILL semantics" : false,
  },
  async (t) => {
    const context = fixture(t);
    const holder = await startHolder(context);
    const inode = lstatSync(join(context.cwd, LOCK_FILE), { bigint: true }).ino;
    const waiter = startWorker(
      context,
      `
    signal("attempting");
    await withBudgetLock(cwd, async () => signal("acquired"));
  `,
    );
    await waiter.wait("ready");
    waiter.child.send("start");
    await waiter.wait("attempting");
    await delay(100);
    assert.ok(!waiter.messages.includes("acquired"));
    holder.child.kill("SIGKILL");
    await holder.done;
    assert.equal(holder.child.signalCode, "SIGKILL");
    await waiter.wait("acquired");
    await waiter.finish();
    assert.equal(lstatSync(join(context.cwd, LOCK_FILE), { bigint: true }).ino, inode);
  },
);

test(
  "bounds contention at five seconds without reclaiming an old live lock",
  { timeout: 12000 },
  async (t) => {
    const context = fixture(t);
    const holder = await startHolder(context);
    const file = join(context.cwd, LOCK_FILE);
    const inode = lstatSync(file, { bigint: true }).ino;
    utimesSync(file, new Date(0), new Date(0));
    let called = false;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    try {
      await assert.rejects(
        withBudgetLock(context.cwd, async () => {
          called = true;
        }),
        /Timed out.*5000 ms/,
      );
    } finally {
      clearInterval(timer);
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 4800 && elapsed < 7500, `Acquisition took ${elapsed} ms`);
    assert.ok(ticks > 20, "Contention must yield to the event loop");
    assert.equal(called, false);
    assert.equal(lstatSync(file, { bigint: true }).ino, inode);
    holder.child.send("release");
    await holder.finish();
    await withBudgetLock(context.cwd, async () => undefined);
  },
);

test(
  "local alias waiters cannot release a holder's cross-process lock",
  {
    timeout: 10000,
    skip: process.platform === "win32" ? "Directory symlinks require Windows privileges" : false,
  },
  async (t) => {
    const context = fixture(t);
    const alias = join(context.cwd, "alias");
    symlinkSync(context.cwd, alias, "dir");
    const outsider = startWorker(
      context,
      `
    signal("attempting");
    await withBudgetLock(cwd, async () => signal("acquired"));
  `,
    );
    await outsider.wait("ready");
    let local: Promise<void> | undefined;
    let localAcquired = false;
    await withBudgetLock(context.cwd, async () => {
      local = withBudgetLock(alias, async () => {
        localAcquired = true;
      });
      outsider.child.send("start");
      await outsider.wait("attempting");
      await delay(150);
      assert.equal(localAcquired, false);
      assert.ok(!outsider.messages.includes("acquired"));
    });
    await local;
    await outsider.wait("acquired");
    await outsider.finish();
    assert.equal(localAcquired, true);
  },
);

test(
  "local waiters time out without releasing the holder's transaction",
  { timeout: 12000 },
  async (t) => {
    const context = fixture(t);
    const outsider = startWorker(
      context,
      `
    signal("attempting");
    await withBudgetLock(cwd, async () => signal("acquired"));
  `,
    );
    await outsider.wait("ready");
    let called = false;
    await withBudgetLock(context.cwd, async () => {
      const started = performance.now();
      await assert.rejects(
        withBudgetLock(context.cwd, async () => {
          called = true;
        }),
        /Timed out.*5000 ms/,
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 4800 && elapsed < 7500, `Local wait took ${elapsed} ms`);
      outsider.child.send("start");
      await outsider.wait("attempting");
      await delay(100);
      assert.ok(!outsider.messages.includes("acquired"));
    });
    assert.equal(called, false);
    await outsider.wait("acquired");
    await outsider.finish();
    await withBudgetLock(context.cwd, async () => undefined);
  },
);

test("refuses hard links and directories", async (t) => {
  const { cwd } = fixture(t);
  const target = join(cwd, "target");
  writeFileSync(target, "private target");
  const file = join(cwd, LOCK_FILE);
  const cases = [() => linkSync(target, file), () => mkdirSync(file)];
  for (const setup of cases) {
    setup();
    let called = false;
    await assert.rejects(
      withBudgetLock(cwd, async () => {
        called = true;
      }),
      /Could not lock budget usage/,
    );
    assert.equal(called, false);
    assert.equal(readFileSync(target, "utf8"), "private target");
    assert.ok(!existsSync(join(cwd, "absent")));
    rmSync(file, { recursive: true });
  }
});

test(
  "refuses symbolic links and dangling links",
  {
    skip: process.platform === "win32" ? "File symlinks require Windows privileges" : false,
  },
  async (t) => {
    const { cwd } = fixture(t);
    const target = join(cwd, "target");
    writeFileSync(target, "private target");
    const missing = join(cwd, "absent");
    const file = join(cwd, LOCK_FILE);
    for (const destination of [target, missing]) {
      symlinkSync(destination, file);
      let called = false;
      await assert.rejects(
        withBudgetLock(cwd, async () => {
          called = true;
        }),
        /Could not lock budget usage/,
      );
      assert.equal(called, false);
      assert.equal(readFileSync(target, "utf8"), "private target");
      assert.ok(!existsSync(missing));
      rmSync(file);
    }
  },
);

test("rejects corrupt databases immediately and sanitizes diagnostics", async (t) => {
  const { cwd } = fixture(t);
  const directoryName = process.platform === "win32" ? "secret-token" : "secret-\u001b[31m-token";
  const secretDirectory = join(cwd, directoryName);
  mkdirSync(secretDirectory);
  const file = join(secretDirectory, LOCK_FILE);
  const content = "secret database content".repeat(100);
  writeFileSync(file, content);
  const started = performance.now();
  let called = false;
  await assert.rejects(
    withBudgetLock(secretDirectory, async () => {
      called = true;
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Could not lock budget usage. Check .kit-budget-lock.sqlite.");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.ok(performance.now() - started < 2000);
  assert.equal(called, false);
  assert.equal(readFileSync(file, "utf8"), content);
  rmSync(file);
  await withBudgetLock(secretDirectory, async () => undefined);
});

test(
  "refuses an inode replaced while acquisition waits",
  {
    skip: process.platform === "win32" ? "Windows refuses to rename an open database" : false,
  },
  async (t) => {
    const context = fixture(t);
    const holder = await startHolder(context);
    let called = false;
    const pending = assert.rejects(
      withBudgetLock(context.cwd, async () => {
        called = true;
      }),
      /Could not lock budget usage/,
    );
    await delay(100);
    const file = join(context.cwd, LOCK_FILE);
    renameSync(file, join(context.cwd, "displaced.sqlite"));
    writeFileSync(file, "replacement");
    holder.child.send("release");
    await holder.finish();
    await pending;
    assert.equal(called, false);
    assert.equal(readFileSync(file, "utf8"), "replacement");
  },
);

test("a missing project directory fails without exposing its path", async (t) => {
  const { cwd } = fixture(t);
  await assert.rejects(
    withBudgetLock(join(cwd, "private-project"), async () => undefined),
    {
      message: "Could not lock budget usage. Check .kit-budget-lock.sqlite.",
    },
  );
});
