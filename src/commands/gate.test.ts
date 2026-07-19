import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runGateFailClosed } from "./gate.js";

describe("runGateFailClosed", () => {
  let origExit: typeof process.exit | undefined;
  let origArgv: string[] | undefined;
  let origLog: typeof console.log | undefined;

  afterEach(() => {
    if (origExit) process.exit = origExit;
    if (origArgv) process.argv = origArgv;
    if (origLog) console.log = origLog;
    origExit = origArgv = origLog = undefined;
  });

  it("passes the handler's boolean through when it does not throw", async () => {
    assert.equal(await runGateFailClosed("gate-fs", () => true), true);
    assert.equal(await runGateFailClosed("gate-fs", async () => false), false);
  });

  it("a throwing handler DENIES via exit 2 (fail-closed) — never returns allow", async () => {
    origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("__exit__"); // stand in for process.exit's non-return
    }) as unknown as typeof process.exit;

    await assert.rejects(
      runGateFailClosed("gate-fs", () => {
        throw new Error("cwd removed mid-run");
      }),
      /__exit__/,
    );
    assert.equal(exitCode, 2); // exit 2 = PreToolUse deny, NOT exit 1 (which would allow)
  });

  it("uses the Cline cancel contract (no exit 2) under --format cline", async () => {
    origArgv = process.argv;
    process.argv = ["node", "kit", "gate-fs", "--format", "cline"];
    origLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));

    const r = await runGateFailClosed("gate-fs", () => {
      throw new Error("boom");
    });
    assert.equal(r, false); // Cline blocks via stdout {cancel:true}, returns (no exit 2)
    assert.match(logs.join("\n"), /"cancel":true/);
    assert.match(logs.join("\n"), /fail-closed/);
  });
});
