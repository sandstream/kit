/** Exercise receipt transactions across separate processes and a real Git worktree. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFailedReviewRuns } from "./review-receipt-io.js";

const fixture = fileURLToPath(new URL("./review-receipt-process.test-support.js", import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-process-"));
  const root = join(dir, "repo");
  const signals = join(dir, "signals");
  const anchor = join(dir, "anchor");
  mkdirSync(root);
  mkdirSync(signals);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { dir, root, signals, anchor, head };
}

function runChild(
  root: string,
  mode: string,
  signals: string,
  anchor: string,
  remoteHead?: string,
) {
  return spawnSync(process.execPath, [fixture, root, mode, signals], {
    encoding: "utf8",
    env: {
      ...process.env,
      KIT_AUDIT_ANCHOR_DIR: anchor,
      ...(remoteHead ? { KIT_TEST_REMOTE_HEAD: remoteHead } : {}),
    },
    timeout: 30000,
  });
}

async function waitFor(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`fixture exited before ready: ${child.exitCode ?? child.signalCode}`);
    if (Date.now() > deadline) throw new Error("fixture did not become ready");
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function childExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((done) => child.once("exit", done));
}

async function count(root: string, anchor: string, head: string): Promise<number> {
  const previous = process.env.KIT_AUDIT_ANCHOR_DIR;
  process.env.KIT_AUDIT_ANCHOR_DIR = anchor;
  try {
    return await readFailedReviewRuns(root, head, "kit review --receipt");
  } finally {
    if (previous === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
    else process.env.KIT_AUDIT_ANCHOR_DIR = previous;
  }
}

describe("review receipt process transactions", () => {
  it("prevents overlapping reviews and records both failures after retry", async () => {
    const test = setup();
    const first = spawn(process.execPath, [fixture, test.root, "hold", test.signals], {
      env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
      stdio: "ignore",
    });
    try {
      await waitFor(join(test.signals, "hold.ready"), first);
      const recovery = runChild(test.root, "recover", test.signals, test.anchor);
      assert.notEqual(recovery.status, 0);
      assert.match(recovery.stderr, /review owner is still running/);
      const blocked = runChild(test.root, "compete", test.signals, test.anchor);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /review is running or incomplete/);
      const escalation = runChild(test.root, "escalate", test.signals, test.anchor);
      assert.notEqual(escalation.status, 0);
      assert.match(escalation.stderr, /review is running or incomplete/);
      assert.equal(existsSync(join(test.signals, "compete.ready")), false);
      writeFileSync(join(test.signals, "release"), "release");
      assert.equal(await childExit(first), 0);
      const second = runChild(test.root, "second", test.signals, test.anchor);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(await count(test.root, test.anchor, test.head), 2);
    } finally {
      if (first.exitCode === null) first.kill();
      rmSync(test.dir, { recursive: true, force: true });
    }
  });
});

describe("review receipt interruption recovery", () => {
  it("recovers an interrupted process without counting it as a gate failure", async () => {
    const test = setup();
    const child = spawn(process.execPath, [fixture, test.root, "crash", test.signals], {
      env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
      stdio: "ignore",
    });
    try {
      await waitFor(join(test.signals, "crash.ready"), child);
      child.kill("SIGKILL");
      await childExit(child);
      const blocked = runChild(test.root, "verify", test.signals, test.anchor);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /review is running or incomplete/);
      const unresolved = runChild(test.root, "recover", test.signals, test.anchor);
      assert.notEqual(unresolved.status, 0);
      assert.match(unresolved.stderr, /Review result is unknown/);
      const recovered = runChild(test.root, "recover-reviewed", test.signals, test.anchor);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.match(recovered.stdout, /Unknown review result and human assessment recorded/);
      assert.equal(await count(test.root, test.anchor, test.head), 0);
      const current = JSON.parse(
        readFileSync(join(test.root, ".kit-review-receipt.json"), "utf8"),
      ) as { run_status: string };
      assert.equal(current.run_status, "interrupted");
      const verify = runChild(test.root, "verify", test.signals, test.anchor);
      assert.equal(verify.status, 0, verify.stderr);
      assert.match(verify.stdout, /review was interrupted/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(test.dir, { recursive: true, force: true });
    }
  });

  for (const phase of ["pending", "history"] as const) {
    it(`recovers a signed failure after process termination at ${phase}`, async () => {
      const test = setup();
      const mode = `crash-after-${phase}`;
      const child = spawn(process.execPath, [fixture, test.root, mode, test.signals], {
        env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
        stdio: "ignore",
      });
      try {
        await waitFor(join(test.signals, `${mode}.${phase}`), child);
        child.kill("SIGKILL");
        await childExit(child);
        const recovered = runChild(test.root, "recover", test.signals, test.anchor);
        assert.equal(recovered.status, 0, recovered.stderr);
        assert.equal(await count(test.root, test.anchor, test.head), 1);
        const second = runChild(test.root, "second", test.signals, test.anchor);
        assert.equal(second.status, 0, second.stderr);
        assert.equal(await count(test.root, test.anchor, test.head), 2);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        rmSync(test.dir, { recursive: true, force: true });
      }
    });
  }
});

describe("review receipt append recovery", () => {
  it("recovers a failed history append without losing the signed failure", async (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root can bypass the read-only file mode");
      return;
    }
    const test = setup();
    try {
      const failed = runChild(test.root, "append-failure", test.signals, test.anchor);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /EACCES|EPERM/);
      chmodSync(join(test.root, ".kit-review-receipt-history.jsonl"), 0o600);
      const recovered = runChild(test.root, "recover", test.signals, test.anchor);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.match(recovered.stdout, /receipt and history recovered/);
      assert.equal(await count(test.root, test.anchor, test.head), 1);
      const second = runChild(test.root, "second", test.signals, test.anchor);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(await count(test.root, test.anchor, test.head), 2);
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  });
});

it("keeps a partial staged record locked until it is inspected", async () => {
  const test = setup();
  const child = spawn(process.execPath, [fixture, test.root, "crash", test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  try {
    await waitFor(join(test.signals, "crash.ready"), child);
    child.kill("SIGKILL");
    await childExit(child);
    const staged = join(test.root, ".git", "kit-review-receipt.lock", "pending-0123456789abcdef");
    writeFileSync(staged, "partial");
    const blocked = runChild(test.root, "recover", test.signals, test.anchor);
    assert.notEqual(blocked.status, 0);
    assert.equal(existsSync(staged), true);
    unlinkSync(staged);
    const recovered = runChild(test.root, "recover-reviewed", test.signals, test.anchor);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Unknown review result and human assessment recorded/);
    assert.equal(await count(test.root, test.anchor, test.head), 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("does not replace a clean tracked receipt during recovery", async () => {
  const test = setup();
  const child = spawn(process.execPath, [fixture, test.root, "crash", test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  try {
    await waitFor(join(test.signals, "crash.ready"), child);
    child.kill("SIGKILL");
    await childExit(child);
    const receipt = join(test.root, ".kit-review-receipt.json");
    writeFileSync(receipt, "user data");
    execFileSync("git", ["add", ".kit-review-receipt.json"], { cwd: test.root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "track receipt",
      ],
      { cwd: test.root },
    );
    const blocked = runChild(test.root, "recover", test.signals, test.anchor);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /output paths must not contain tracked files/);
    assert.equal(readFileSync(receipt, "utf8"), "user data");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("keeps a corrupt history locked instead of publishing a later pass", () => {
  const test = setup();
  try {
    writeFileSync(join(test.root, ".kit-review-receipt-history.jsonl"), "corrupt\n");
    const result = runChild(test.root, "pass", test.signals, test.anchor);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(test.root, ".kit-review-receipt.json")), false);
    assert.equal(existsSync(join(test.root, ".git", "kit-review-receipt.lock")), true);
    const recover = runChild(test.root, "recover", test.signals, test.anchor);
    assert.notEqual(recover.status, 0);
    assert.equal(existsSync(join(test.root, ".git", "kit-review-receipt.lock")), true);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("escalates two failures after a later passing run using the failed output", () => {
  const test = setup();
  try {
    for (const mode of ["first", "second", "pass"]) {
      const result = runChild(test.root, mode, test.signals, test.anchor);
      assert.equal(result.status, 0, result.stderr);
    }
    const result = runChild(test.root, "escalate", test.signals, test.anchor);
    assert.equal(result.status, 0, result.stderr);
    const items = JSON.parse(result.stdout) as { name: string; issue: string }[];
    const issue = items.find((item) => item.name === "review gate")?.issue ?? "";
    const digest = createHash("sha256")
      .update(JSON.stringify({ stdout: "second", stderr: "" }))
      .digest("hex");
    assert.match(issue, /Failed 2 times/);
    assert.ok(issue.includes(digest));
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("recovers a complete signed result left in a staging file", async () => {
  const test = setup();
  const child = spawn(process.execPath, [fixture, test.root, "staged-completed", test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  try {
    await waitFor(join(test.signals, "staged-completed.ready"), child);
    child.kill("SIGKILL");
    await childExit(child);
    const recovered = runChild(test.root, "recover", test.signals, test.anchor);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /receipt and history recovered/);
    assert.equal(await count(test.root, test.anchor, test.head), 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("does not publish a recovered receipt after the local commit changes", async () => {
  const test = setup();
  const child = spawn(process.execPath, [fixture, test.root, "crash", test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  try {
    await waitFor(join(test.signals, "crash.ready"), child);
    child.kill("SIGKILL");
    await childExit(child);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "new head",
      ],
      { cwd: test.root },
    );
    const recovered = runChild(test.root, "recover-reviewed", test.signals, test.anchor, test.head);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /pull request or local commit changed/);
    assert.equal(existsSync(join(test.root, ".kit-review-receipt.json")), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("keeps the transaction locked if the local commit changes after history append", async () => {
  const test = setup();
  const mode = "crash-after-history";
  const child = spawn(process.execPath, [fixture, test.root, mode, test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  try {
    await waitFor(join(test.signals, `${mode}.history`), child);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "new head",
      ],
      { cwd: test.root },
    );
    writeFileSync(join(test.signals, "release"), "release");
    assert.notEqual(await childExit(child), 0);
    assert.equal(existsSync(join(test.root, ".kit-review-receipt.json")), false);
    assert.equal(existsSync(join(test.root, ".git", "kit-review-receipt.lock")), true);
    assert.equal(await count(test.root, test.anchor, test.head), 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("requires inspection before clearing an interrupted recovery claim", async () => {
  const test = setup();
  const owner = spawn(process.execPath, [fixture, test.root, "crash", test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  let recovery: ChildProcess | undefined;
  try {
    await waitFor(join(test.signals, "crash.ready"), owner);
    owner.kill("SIGKILL");
    await childExit(owner);
    recovery = spawn(process.execPath, [fixture, test.root, "claim-crash", test.signals], {
      env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
      stdio: "ignore",
    });
    await waitFor(join(test.signals, "claim-crash.ready"), recovery);
    const active = runChild(test.root, "recover", test.signals, test.anchor);
    assert.notEqual(active.status, 0);
    assert.match(active.stderr, /recovery is running or incomplete/);
    recovery.kill("SIGKILL");
    await childExit(recovery);
    const stale = runChild(test.root, "recover", test.signals, test.anchor);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /recovery is running or incomplete/);
    const claim = join(test.root, ".git", "kit-review-receipt.lock", "recovery");
    const ownerFile = join(claim, "owner.json");
    const record = JSON.parse(readFileSync(ownerFile, "utf8")) as { pid: number };
    assert.equal(record.pid, recovery.pid);
    unlinkSync(ownerFile);
    rmdirSync(claim);
    const recovered = runChild(test.root, "recover-reviewed", test.signals, test.anchor);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Unknown review result and human assessment recorded/);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    if (recovery && recovery.exitCode === null && recovery.signalCode === null) recovery.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("does not mistake a dangling start marker for an unstarted review", async (t) => {
  const test = setup();
  const child = spawn(process.execPath, [fixture, test.root, "crash", test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  try {
    await waitFor(join(test.signals, "crash.ready"), child);
    child.kill("SIGKILL");
    await childExit(child);
    const marker = join(test.root, ".git", "kit-review-receipt.lock", "started");
    unlinkSync(marker);
    try {
      symlinkSync(join(test.dir, "missing"), marker);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows cannot create symbolic links in this test environment");
        return;
      }
      throw error;
    }
    const recovered = runChild(test.root, "recover", test.signals, test.anchor);
    assert.notEqual(recovered.status, 0);
    assert.match(recovered.stderr, /invalid review transaction file/);
    assert.equal(existsSync(join(test.root, ".git", "kit-review-receipt.lock")), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(test.dir, { recursive: true, force: true });
  }
});
