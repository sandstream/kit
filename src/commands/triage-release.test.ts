import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cmdTriageCargo, cmdTriageGo } from "./triage-release.js";

type Command = typeof cmdTriageCargo;

async function run(command: Command, args: string[], passed = true) {
  const out: string[] = [];
  const seen: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    const ok = await command(args, async (_cwd, target) => {
      seen.push(target);
      return { passed, output: passed ? "TRIAGE PASSED" : "TRIAGE HELD: cooling period" };
    });
    return { ok, out: out.join("\n"), seen };
  } finally {
    [console.log, console.error] = [log, err];
  }
}

describe("kit triage cargo / kit triage go", () => {
  it("needs a target", async () => {
    const cargo = await run(cmdTriageCargo, []);
    assert.equal(cargo.ok, false);
    assert.match(cargo.out, /Usage: kit triage cargo <crate>\[@version\]/);
    const go = await run(cmdTriageGo, ["--json"]);
    assert.equal(go.ok, false);
    assert.match(go.out, /Usage: kit triage go <package>\[@version\]/);
  });

  it("prints the report and returns the verdict", async () => {
    const passed = await run(cmdTriageCargo, ["ripgrep@14.1.1"]);
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.seen, ["ripgrep@14.1.1"]);
    assert.match(passed.out, /Running triage on crate: ripgrep@14\.1\.1/);
    assert.match(passed.out, /TRIAGE PASSED/);
    assert.doesNotMatch(passed.out, /Review the lines above/);
  });

  it("returns false and asks for a review when the release is held", async () => {
    const held = await run(cmdTriageGo, ["example.com/tool@latest"], false);
    assert.equal(held.ok, false);
    assert.match(held.out, /Running triage on Go module: example\.com\/tool@latest/);
    assert.match(held.out, /TRIAGE HELD: cooling period/);
    assert.match(held.out, /Review the lines above before installing/);
  });
});
