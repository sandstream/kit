import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { printContextReport } from "./context-report.js";
import type { ContextFinding } from "../context-lock.js";

function run(findings: ContextFinding[]): { ok: boolean; out: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { ok: printContextReport(findings), out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}
const f = (status: ContextFinding["status"], field = "project"): ContextFinding => ({
  tool: "gcloud",
  field,
  status,
  expected: "a",
  actual: status === "ok" ? "a" : "b",
});

describe("printContextReport", () => {
  it("passes when every row is ok or unknown", () => {
    assert.equal(run([f("ok"), f("unknown")]).ok, true);
  });

  it("fails on a mismatch and says so", () => {
    const r = run([f("mismatch")]);
    assert.equal(r.ok, false);
    assert.match(r.out, /1 mismatch/);
  });

  it("fails on an unchecked key and names it without a value", () => {
    const r = run([{ ...f("unchecked", "projct"), actual: null }]);
    assert.equal(r.ok, false);
    assert.match(r.out, /gcloud\.projct/);
    assert.match(r.out, /not checked/);
  });

  it("warns that an identity mismatch means a partial view", () => {
    const r = run([f("mismatch", "account")]);
    assert.match(r.out, /PARTIAL view/);
  });
});
