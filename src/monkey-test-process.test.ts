import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { groupHasLiveMember, groupRunning, runShell, stopProcess } from "./monkey-test-process.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function nodeShellCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

describe("monkey-test process runner", () => {
  it("redacts command output with secrets from the temporary environment", async () => {
    const secret = "sk_test_process_runner_secret_123456";
    const result = await runShell(
      nodeShellCommand(
        "process.stdout.write(process.env.TEST_SECRET); process.stderr.write(process.env.TEST_SECRET)",
      ),
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_SECRET: secret },
        timeoutMs: 5_000,
      },
    );

    assert.equal(result.ok, true);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.match(result.stderr, /\[REDACTED\]/);
  });

  it("times out and terminates a command that ignores SIGTERM", async () => {
    const result = await runShell(
      nodeShellCommand("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
      { cwd: process.cwd(), env: process.env, timeoutMs: 25 },
    );

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
  });

  it(
    "closes a timed-out Windows shell and its child process",
    { skip: process.platform !== "win32" },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kit-monkey-tree-"));
      const pidFile = join(dir, "child.pid");
      let pid = 0;
      try {
        const command = nodeShellCommand(
          "require('node:fs').writeFileSync(process.env.CHILD_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)",
        );
        const result = await runShell(command, {
          cwd: dir,
          env: { ...process.env, CHILD_PID_FILE: pidFile },
          timeoutMs: 1_000,
        });
        pid = Number(readFileSync(pidFile, "utf8"));
        assert.equal(result.timedOut, true);
        assert.equal(result.ok, false);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (pid) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
        rmTemp(dir);
      }
    },
  );

  it("stops a detached process tree", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    await once(child, "spawn");

    try {
      assert.equal(await stopProcess(child), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

describe("groupHasLiveMember reads /proc so zombies do not count as running", () => {
  // A fake /proc: pid -> [comm, state, pgrp]. comm can hold spaces and parentheses.
  function fakeProc(procs: Record<string, [string, string, number]>): string {
    const root = mkdtempSync(join(tmpdir(), "kit-fake-proc-"));
    mkdirSync(join(root, "self"));
    for (const [pid, [comm, state, pgrp]] of Object.entries(procs)) {
      mkdirSync(join(root, pid));
      writeFileSync(join(root, pid, "stat"), `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1`);
    }
    return root;
  }

  it("a group whose members are all zombies is not running; one live member is", (t) => {
    const root = fakeProc({
      "40": ["node", "Z", 40],
      "41": ["sh ) (x", "Z", 40],
      "50": ["node", "S", 50],
      "51": ["node", "Z", 50],
    });
    t.after(() => rmTemp(root));
    assert.equal(groupHasLiveMember(40, root), false);
    assert.equal(groupHasLiveMember(50, root), true);
  });

  it("a zombie leader with a live member is still running (the fast path cannot skip the scan)", (t) => {
    const root = fakeProc({ "70": ["sh", "Z", 70], "71": ["node", "S", 70] });
    t.after(() => rmTemp(root));
    assert.equal(groupHasLiveMember(70, root), true);
  });

  it("answers undefined, never false, when /proc shows no member or cannot be read", (t) => {
    const root = fakeProc({ "60": ["node", "S", 60] });
    t.after(() => rmTemp(root));
    assert.equal(groupHasLiveMember(99, root), undefined);
    assert.equal(groupHasLiveMember(60, join(root, "missing")), undefined);
  });
});

describe("groupRunning: a stopped group stays stopped", () => {
  it("rechecks the group when the /proc scan finds no member, so a reap in between reads as gone", () => {
    const answers = [true, false]; // exists before the scan; reaped by the time we ask again
    const exists = () => answers.shift() ?? false;
    assert.equal(
      groupRunning(80, true, exists, () => undefined),
      false,
    );
  });

  it("still reads an unanswerable scan as running while the group exists", () => {
    assert.equal(
      groupRunning(
        81,
        true,
        () => true,
        () => undefined,
      ),
      true,
    );
  });

  it("trusts the scan when it answers, and kill(-pgid, 0) alone off Linux", () => {
    assert.equal(
      groupRunning(
        82,
        true,
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      groupRunning(
        83,
        true,
        () => true,
        () => true,
      ),
      true,
    );
    assert.equal(
      groupRunning(
        84,
        false,
        () => true,
        () => false,
      ),
      true,
    );
    assert.equal(
      groupRunning(
        85,
        true,
        () => false,
        () => true,
      ),
      false,
    );
  });
});
