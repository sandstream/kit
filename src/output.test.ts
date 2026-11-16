import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStep, fmtDuration, printSummary } from "./output.js";
import type { SecurityCheckResult } from "./check-security.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Capture everything written to stdout (console.log + process.stdout.write),
// so assertions hold for both the TTY (rewrite) and non-TTY (line) branches.
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    text: () => stripAnsi(chunks.join("")),
    restore: () => {
      (process.stdout as unknown as { write: unknown }).write = orig;
    },
  };
}

describe("fmtDuration", () => {
  it("renders sub-second values in milliseconds", () => {
    assert.equal(fmtDuration(0), "0ms");
    assert.equal(fmtDuration(250), "250ms");
    assert.equal(fmtDuration(999), "999ms");
  });

  it("renders one-decimal seconds at and above 1s", () => {
    assert.equal(fmtDuration(1000), "1.0s");
    assert.equal(fmtDuration(1540), "1.5s");
    assert.equal(fmtDuration(16000), "16.0s");
  });
});

describe("runStep", () => {
  it("returns the fn result and renders ▶ start + ✓ done with the label", async () => {
    const cap = captureStdout();
    let result: number;
    try {
      result = await runStep("build", async () => 42);
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.equal(result, 42);
    assert.match(out, /▶.*build/);
    assert.match(out, /✓.*build/);
  });

  it("marks the step ✗ and re-throws when the fn rejects", async () => {
    const cap = captureStdout();
    let threw = false;
    try {
      await runStep("security scan", async () => {
        throw new Error("boom");
      });
    } catch (err) {
      threw = true;
      assert.match((err as Error).message, /boom/);
    } finally {
      cap.restore();
    }
    assert.ok(threw, "runStep re-throws the underlying error");
    assert.match(cap.text(), /✗.*security scan/);
  });
});

/**
 * The verdict line must not add skips to passes.
 *
 * Measured before this was fixed: a workspace root holding `web/` and `illithid/` side by side
 * printed "All 25 checks passed ✓" while 15 of the 25 had never run, and the same command one
 * directory down reported 30 known dependency vulnerabilities (high). Every skip was individually
 * truthful; the summary that added them up was not. Same defect class as #517 — a check that could
 * not run rendering as success — one level up, in the line most people read instead of the rows.
 *
 * So these are arithmetic properties: the printed numbers must account for every check, and the
 * words "All … passed" may appear only when everything actually ran.
 */
describe("printSummary", () => {
  const sec = (name: string, status: SecurityCheckResult["status"]): SecurityCheckResult => ({
    category: "dependency",
    name,
    status,
    detail: status === "skip" ? "no package.json found" : "",
  });

  it("never claims everything passed when something could not run", () => {
    const cap = captureStdout();
    try {
      printSummary([], [], [], [sec("a", "pass"), sec("b", "skip"), sec("c", "skip")]);
    } finally {
      cap.restore();
    }
    const text = cap.text();
    assert.doesNotMatch(text, /All \d+ checks passed/, `false green:\n${text}`);
    assert.match(text, /1 passed/);
    assert.match(text, /2 could not run/);
    // And it must say what the verdict does cover, since that is the number a reader acts on.
    assert.match(text, /2 of 3 check\(s\) did not run/);
  });

  it("still says all passed when everything actually ran", () => {
    const cap = captureStdout();
    try {
      printSummary([], [], [], [sec("a", "pass"), sec("b", "pass")]);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /All 2 checks passed/);
  });

  it("accounts for every check when there are findings as well as non-runs", () => {
    const cap = captureStdout();
    try {
      printSummary(
        [],
        [],
        [],
        [sec("a", "pass"), sec("b", "skip"), sec("c", "warn"), sec("d", "fail")],
      );
    } finally {
      cap.restore();
    }
    const text = cap.text();
    const m = /(\d+)\/(\d+) passed/.exec(text);
    assert.ok(m, `expected an n/total line:\n${text}`);
    assert.equal(Number(m[1]), 1);
    assert.equal(Number(m[2]), 4);
    assert.match(text, /1 could not run/);
    assert.match(text, /2 real issues/, "a warn and a fail are both findings, not non-runs");
  });

  it("does not report an empty directory as a clean sweep", () => {
    const cap = captureStdout();
    try {
      printSummary([], [], [], []);
    } finally {
      cap.restore();
    }
    assert.doesNotMatch(cap.text(), /All 0 checks passed/);
    assert.match(cap.text(), /no checks applied/);
  });
});

describe("printSummary incomplete findings", () => {
  const sec = (name: string, status: SecurityCheckResult["status"]): SecurityCheckResult => ({
    category: "dependency",
    name,
    status,
    detail: "",
  });

  it("reports an incomplete scan and its known finding together", () => {
    const cap = captureStdout();
    try {
      printSummary(
        [],
        [],
        [],
        [{ ...sec("bundle", "fail"), didNotRun: true, scanIncomplete: true, hasFindings: true }],
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /1 incomplete check/);
    assert.match(cap.text(), /1 real issue/);
    assert.doesNotMatch(cap.text(), /setup gap|kit install/);
  });

  it("reports an incomplete scan without treating it as setup or a finding", () => {
    const cap = captureStdout();
    try {
      printSummary(
        [],
        [],
        [],
        [{ ...sec("bundle", "fail"), didNotRun: true, scanIncomplete: true }],
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /1 incomplete check/);
    assert.doesNotMatch(cap.text(), /setup gap|real issue|kit install/);
  });

  it("keeps a scan with no known findings as a setup gap", () => {
    const cap = captureStdout();
    try {
      printSummary([], [], [], [{ ...sec("scanner", "fail"), didNotRun: true }]);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /1 setup gap/);
    assert.doesNotMatch(cap.text(), /real issue|incomplete check/);
  });
});

describe("printSummary: tools, services, secrets and deploy", () => {
  const tool = (ok: boolean) => ({ name: "t", ok }) as never;
  const service = (authenticated: boolean) => ({ name: "s", authenticated }) as never;
  const secret = (available: boolean) => ({ name: "k", available }) as never;
  const deploy = (status: string, didNotRun = false) =>
    ({ name: "d", status, detail: "", didNotRun }) as never;
  const summary = (...args: Parameters<typeof printSummary>): string => {
    const cap = captureStdout();
    try {
      printSummary(...args);
    } finally {
      cap.restore();
    }
    return cap.text();
  };

  it("counts a missing tool, an unauthenticated service and a missing secret as setup gaps", () => {
    const text = summary([tool(true), tool(false)], [service(false)], [secret(false)]);
    assert.match(text, /1\/4 passed/);
    assert.match(text, /3 setup gaps/);
    assert.doesNotMatch(text, /real issue/);
    assert.match(text, /Setup gaps are expected on a fresh clone/);
    assert.match(text, /kit install .*kit login .*kit secrets/);
  });

  it("uses the singular for one setup gap and one real issue", () => {
    const text = summary([tool(false)], [], [], undefined, [deploy("fail")]);
    assert.match(text, /0\/2 passed/);
    assert.match(text, /1 setup gap(?!s)/);
    assert.match(text, /1 real issue(?!s)/);
    assert.match(text, /Real issues are genuine findings/);
    assert.match(text, /kit check --category security/);
  });

  it("treats a deploy check that did not run as a setup gap, a skipped one as neither", () => {
    const text = summary([], [], [], undefined, [
      deploy("pass"),
      deploy("fail", true),
      deploy("skip"),
    ]);
    assert.match(text, /1\/3 passed/);
    assert.match(text, /1 could not run/);
    assert.match(text, /1 setup gap(?!s)/);
    assert.doesNotMatch(text, /real issue/);
  });

  it("says all passed when tools, services, secrets and deploy checks all pass", () => {
    const text = summary([tool(true)], [service(true)], [secret(true)], undefined, [
      deploy("pass"),
    ]);
    assert.match(text, /All 4 checks passed ✓/);
  });
});
