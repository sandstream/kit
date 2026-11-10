import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cmdTriageGem } from "./triage-gem.js";
import type { GemTriageDeps } from "../triage-gem.js";

async function run(args: string[], deps: GemTriageDeps): Promise<{ ok: boolean; out: string }> {
  const out: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    return { ok: await cmdTriageGem(args, deps), out: out.join("\n") };
  } finally {
    [console.log, console.error] = [log, err];
  }
}

const removed: GemTriageDeps = {
  env: {},
  now: () => 0,
  getJson: async () => null,
  postJson: async () => ({ vulns: [{ id: "MAL-2026-19054" }] }),
  airGap: async () => ({ enabled: false, mirrors: {} }),
  lockfile: () => null,
};

describe("kit triage gem", () => {
  it("needs a target", async () => {
    const r = await run([], removed);
    assert.equal(r.ok, false);
    assert.match(r.out, /Usage: kit triage gem <name>\[@version\]/);
  });

  it("prints the report and returns false for a malicious, removed gem", async () => {
    const r = await run(["strutil-core"], removed);
    assert.equal(r.ok, false);
    assert.match(r.out, /malicious package: MAL-2026-19054/);
    assert.match(r.out, /Review the lines above before installing/);
  });
});
