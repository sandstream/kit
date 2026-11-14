/**
 * A moved floor is a gap, and every freeze is audited.
 *
 * kit-research retro-skill-self-evolving-agents-vs-kit: a status edit, a deleted ADR, or removing
 * its rules turned a red `kit adr check` green, and `kit adr freeze` left no audit record.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeAdrBaseline, runAdrGate } from "./commands/adr.js";
import { loadBaseline, saveBaseline } from "./baseline.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const ADR = (status: string, rules = true) => `---
id: ADR-0001
title: no fixture import
status: ${status}
---

# ADR-0001
${
  rules
    ? `
\`\`\`toml kit-enforce
[[forbid_import]]
import = "^fixture-forbidden$"
paths = "src/**"
message = "no fixture import"
\`\`\`
`
    : ""
}`;

function repo(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-adr-floor-"));
  t.after(() => rmTemp(dir));
  mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), 'import x from "fixture-forbidden";\n');
  writeFileSync(join(dir, "docs", "adr", "0001-x.md"), ADR("accepted"));
  return dir;
}

async function freeze(dir: string): Promise<void> {
  const baseline = await loadBaseline(dir);
  freezeAdrBaseline(baseline, dir);
  await saveBaseline(baseline, dir);
}

const adrFile = (dir: string) => join(dir, "docs", "adr", "0001-x.md");

describe("kit adr check: the floor", () => {
  it("is green after a freeze accepts the current violation", async (t) => {
    const dir = repo(t);
    assert.equal((await runAdrGate(dir)).ok, false);
    await freeze(dir);
    assert.equal((await runAdrGate(dir)).ok, true);
  });

  for (const [how, edit] of [
    ["demoted", (d: string) => writeFileSync(adrFile(d), ADR("superseded"))],
    ["deleted", (d: string) => rmSync(adrFile(d))],
    ["its rules removed", (d: string) => writeFileSync(adrFile(d), ADR("accepted", false))],
  ] as const) {
    it(`fails when an enforced ADR is ${how} after the freeze`, async (t) => {
      const dir = repo(t);
      await freeze(dir);
      edit(dir);
      const gate = await runAdrGate(dir);
      assert.equal(gate.ok, false);
      assert.equal(gate.gaps.length, 1);
      assert.match(gate.gaps[0]!.message, /ADR-0001 was enforced at the last `kit adr freeze`/);
    });
  }

  it("accepts the lower floor after a new freeze, and audits each freeze", async (t) => {
    const dir = repo(t);
    await freeze(dir);
    writeFileSync(adrFile(dir), ADR("superseded"));
    await freeze(dir);
    assert.equal((await runAdrGate(dir)).ok, true);
    const rows = readFileSync(join(dir, ".kit-audit.jsonl"), "utf8").trim().split("\n");
    const freezes = rows.map((r) => JSON.parse(r)).filter((r) => r.operation === "baseline-freeze");
    assert.equal(freezes.length, 2);
    assert.deepEqual(freezes[0].metadata, { phase: "floor-freeze", categories: ["adr"] });
  });
});
