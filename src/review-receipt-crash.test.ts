/** Check recovery after process termination inside filesystem operations. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./review-receipt-process.test-support.js", import.meta.url));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-receipt-crash-"));
  const root = join(dir, "repo"),
    signals = join(dir, "signals"),
    anchor = join(dir, "anchor");
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
      "test",
    ],
    { cwd: root },
  );
  return {
    dir,
    root,
    signals,
    anchor,
    lock: join(root, ".git", "kit-review-receipt.lock"),
    history: join(root, ".kit-review-receipt-history.jsonl"),
  };
}
type Test = ReturnType<typeof setup>;
function run(test: Test, mode: string) {
  return spawnSync(process.execPath, [fixture, test.root, mode, test.signals], {
    encoding: "utf8",
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    timeout: 30000,
  });
}
async function crash(test: Test, mode: string): Promise<void> {
  const child: ChildProcess = spawn(process.execPath, [fixture, test.root, mode, test.signals], {
    env: { ...process.env, KIT_AUDIT_ANCHOR_DIR: test.anchor },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20000;
  try {
    while (!existsSync(join(test.signals, `${mode}.barrier`))) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`fixture exited: ${child.exitCode ?? child.signalCode}`);
      if (Date.now() > deadline) throw new Error("fixture did not reach the barrier");
      await new Promise((done) => setTimeout(done, 20));
    }
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGKILL");
    await exited;
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
function mustSucceed(test: Test, mode: string) {
  const result = run(test, mode);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function mustBlock(test: Test, mode: string) {
  const result = run(test, mode);
  assert.notEqual(result.status, 0, result.stdout);
  return result;
}
function assertUntracked(test: Test, name: string) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", name], {
    cwd: test.root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
}

it("preserves both links when a process dies after publishing history", async () => {
  const test = setup();
  try {
    await crash(test, "crash-history-link");
    const temp = readdirSync(test.root).find((name) =>
      /^\.kit-receipt-[a-f0-9]{32}\.tmp$/.test(name),
    );
    assert.ok(temp);
    const tempPath = join(test.root, temp);
    const fd = openSync(test.history, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      assert.equal(lstatSync(tempPath).ino, fstatSync(fd).ino);
      assert.equal(fstatSync(fd).nlink, 2);
      const blocked = mustBlock(test, "recover");
      assert.ok(blocked.stderr.includes(tempPath));
      assert.ok(blocked.stderr.includes(test.history));
      assert.ok(existsSync(join(test.lock, "pending.json")));
      assert.equal(fstatSync(fd).nlink, 2);
      mustBlock(test, "compete");
      assertUntracked(test, temp);
      unlinkSync(tempPath);
      mustSucceed(test, "recover");
      assert.equal(fstatSync(fd).nlink, 1);
      assert.equal(readFileSync(fd, "utf8").trim().split("\n").length, 1);
      assert.equal(lstatSync(test.history).ino, fstatSync(fd).ino);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("preserves partial history and recovers both failures after inspected repair", async () => {
  const test = setup();
  try {
    mustSucceed(test, "first");
    const original = readFileSync(test.history);
    await crash(test, "crash-partial-append");
    const damaged = readFileSync(test.history);
    assert.ok(damaged.length > original.length);
    const pending = join(test.lock, "pending.json");
    const blocked = mustBlock(test, "recover");
    assert.ok(blocked.stderr.includes(test.history));
    assert.ok(blocked.stderr.includes(pending));
    assert.deepEqual(readFileSync(test.history), damaged);
    assert.ok(existsSync(pending));
    writeFileSync(join(test.dir, "damaged-history.backup"), damaged);
    writeFileSync(test.history, original);
    mustSucceed(test, "recover");
    assert.equal(readFileSync(test.history, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("retains an ownerless lock for inspection", async () => {
  const test = setup();
  try {
    await crash(test, "crash-ownerless");
    const blocked = mustBlock(test, "recover");
    assert.ok(blocked.stderr.includes(join(test.lock, "owner.json")));
    assert.ok(blocked.stderr.includes(test.lock));
    assert.ok(existsSync(test.lock));
    mustBlock(test, "compete");
    renameSync(test.lock, join(test.root, ".git", "archived-lock-for-test"));
    mustSucceed(test, "first");
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("preserves receipt temp files without an ignore rule", async () => {
  const test = setup();
  try {
    await crash(test, "crash-receipt-temp");
    const temp = readdirSync(test.root).find((name) =>
      /^\.kit-review-receipt\.json\.(?:[a-f0-9]{12}|[a-f0-9]{32})\.tmp$/.test(name),
    );
    assert.ok(temp);
    const tempPath = join(test.root, temp),
      content = readFileSync(tempPath);
    const blocked = mustBlock(test, "recover");
    assert.ok(blocked.stderr.includes(tempPath));
    assert.deepEqual(readFileSync(tempPath), content);
    assert.equal(
      JSON.parse(content.toString()).signature,
      JSON.parse(readFileSync(join(test.lock, "pending.json"), "utf8")).signature,
    );
    assertUntracked(test, temp);
    mustBlock(test, "compete");
    renameSync(tempPath, join(test.dir, "saved-receipt"));
    mustSucceed(test, "recover");
    assert.equal(readFileSync(test.history, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("rejects complete history without a newline and does not approve it", () => {
  const test = setup();
  try {
    mustSucceed(test, "first");
    const history = readFileSync(test.history);
    assert.equal(history.at(-1), 10);
    const damaged = history.subarray(0, -1);
    writeFileSync(test.history, damaged);
    const verify = mustSucceed(test, "verify");
    const verification = JSON.parse(verify.stdout) as { ok: boolean; reason: string };
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /retry verification or start a new review/);
    const blocked = mustBlock(test, "pass");
    assert.ok(blocked.stderr.includes(test.history));
    assert.deepEqual(readFileSync(test.history), damaged);
    assert.ok(existsSync(test.lock));
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("gives preservation guidance for complete invalid history records", () => {
  for (const invalid of ["null\n", '{"signature":"invalid"}\n']) {
    const test = setup();
    try {
      writeFileSync(test.history, invalid);
      const blocked = mustBlock(test, "pass");
      assert.ok(blocked.stderr.includes(test.history));
      assert.ok(blocked.stderr.includes(join(test.lock, "pending.json")));
      assert.match(blocked.stderr, /Preserve its original bytes/);
      assert.equal(readFileSync(test.history, "utf8"), invalid);
    } finally {
      rmSync(test.dir, { recursive: true, force: true });
    }
  }
});

it("keeps two failures visible after a signed gate result and process termination", async () => {
  const test = setup();
  try {
    mustSucceed(test, "first");
    await crash(test, "crash-gate");
    const recovered = mustSucceed(test, "recover");
    assert.match(recovered.stdout, /Local gate result recorded/);
    const incomplete = mustSucceed(test, "verify");
    assert.equal(JSON.parse(incomplete.stdout).ok, false);
    assert.match(mustSucceed(test, "escalate").stdout, /Failed 2 times/);
    mustSucceed(test, "pass");
    const escalated = mustSucceed(test, "escalate");
    assert.match(escalated.stdout, /Failed 2 times/);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("recovers a signed gate failure after a GitHub outage", () => {
  const test = setup();
  try {
    mustSucceed(test, "first");
    const failed = mustBlock(test, "gate-network-error");
    assert.match(failed.stderr, /simulated GitHub outage/);
    mustSucceed(test, "recover");
    mustSucceed(test, "pass");
    assert.match(mustSucceed(test, "escalate").stdout, /Failed 2 times/);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("blocks old unresolved interruptions until a signed human decision", () => {
  const test = setup();
  try {
    mustSucceed(test, "pass");
    mustSucceed(test, "legacy-interrupted");
    const history = readFileSync(test.history, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const original = history.find((entry) => entry.run_status === "interrupted");
    assert.ok(original);
    const blocked = JSON.parse(mustSucceed(test, "verify").stdout) as {
      ok: boolean;
      reason: string;
    };
    assert.equal(blocked.ok, false);
    assert.ok(blocked.reason.includes(original.run_id));
    assert.ok(blocked.reason.includes(original.head));
    assert.ok(mustSucceed(test, "escalate").stdout.includes(original.run_id));
    writeFileSync(join(test.signals, "unresolved-run"), original.run_id);
    mustSucceed(test, "resolve");
    assert.equal(JSON.parse(mustSucceed(test, "verify").stdout).ok, true);
    const entries = readFileSync(test.history, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = entries.find((entry) => entry.resolves_run_id === original.run_id);
    assert.equal(decision.head, original.head);
    assert.equal(decision.interruption_disposition, "risk-accepted");
    assert.match(decision.interruption_review, /Inspected previous output/);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("keeps a signed human assessment across a second process interruption", async () => {
  const test = setup();
  try {
    await crash(test, "crash-unknown");
    assert.match(mustBlock(test, "recover").stderr, /Review result is unknown/);
    await crash(test, "recover-assess-crash");
    const pending = JSON.parse(readFileSync(join(test.lock, "pending.json"), "utf8"));
    assert.equal(pending.interruption_disposition, "risk-accepted");
    assert.match(pending.interruption_review, /Human inspected/);
    assert.match(mustBlock(test, "recover").stderr, /recovery is running or incomplete/);
    const claim = join(test.lock, "recovery");
    const owner = JSON.parse(readFileSync(join(claim, "owner.json"), "utf8"));
    assert.ok(Number.isSafeInteger(owner.pid));
    unlinkSync(join(claim, "owner.json"));
    rmdirSync(claim);
    mustSucceed(test, "recover");
    const history = readFileSync(test.history, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].signature, pending.signature);
    mustSucceed(test, "pass");
    assert.equal(JSON.parse(mustSucceed(test, "verify").stdout).ok, true);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("does not append a human assessment to tracked history", () => {
  const test = setup();
  try {
    mustSucceed(test, "legacy-interrupted");
    const before = readFileSync(test.history);
    const original = JSON.parse(before.toString()) as { run_id: string };
    writeFileSync(join(test.signals, "unresolved-run"), original.run_id);
    execFileSync("git", ["add", ".kit-review-receipt-history.jsonl"], { cwd: test.root });
    const blocked = mustBlock(test, "resolve");
    assert.match(blocked.stderr, /output paths must not contain tracked files/);
    assert.deepEqual(readFileSync(test.history), before);
    assert.equal(existsSync(test.lock), false);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});

it("keeps the assessment pending when history becomes tracked during GitHub lookup", () => {
  const test = setup();
  try {
    mustSucceed(test, "legacy-interrupted");
    const before = readFileSync(test.history);
    const original = JSON.parse(before.toString()) as { run_id: string };
    writeFileSync(join(test.signals, "unresolved-run"), original.run_id);
    const blocked = mustBlock(test, "resolve-track-during-gh");
    assert.match(blocked.stderr, /output paths must not contain tracked files/);
    assert.deepEqual(readFileSync(test.history), before);
    assert.ok(existsSync(join(test.lock, "pending.json")));
    execFileSync("git", ["reset", "-q", "--", ".kit-review-receipt-history.jsonl"], {
      cwd: test.root,
    });
    mustSucceed(test, "recover");
    const records = readFileSync(test.history, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[1].resolves_run_id, original.run_id);
  } finally {
    rmSync(test.dir, { recursive: true, force: true });
  }
});
