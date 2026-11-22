/**
 * The negative controls, asserted against the real CLI.
 *
 * `controlHarmlessCommandAllowed` is not a courtesy test: it is what makes the refusal mean
 * something. A gate that refuses everything would pass the first control while being an outage, so
 * the pair is asserted together or neither claim holds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  controlUnverifiableInstall,
  controlHarmlessCommandAllowed,
  proveFloor,
} from "./usage-prove.js";
import { NEGATIVE_CONTROL_SESSION } from "./usage-prove-env.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("the negative controls", () => {
  it("refuse an install whose target cannot be resolved", () => {
    const ctl = controlUnverifiableInstall();
    assert.equal(ctl.verdict, "refused", ctl.observed);
    assert.equal(ctl.ok, true);
  });

  it("and still allow a command that installs nothing — or the first control proves nothing", () => {
    const ctl = controlHarmlessCommandAllowed();
    assert.equal(ctl.verdict, "allowed", ctl.observed);
    assert.equal(ctl.ok, true);
  });
});

describe("the env-write gate controls in the floor proof", () => {
  it("are part of the floor proof", () => {
    const names = proveFloor().controls.map((c) => c.name);
    assert.ok(
      names.some((n) => /env-write gate refuses/.test(n)),
      names.join(" | "),
    );
    assert.ok(
      names.some((n) => /env-write gate allows/.test(n)),
      names.join(" | "),
    );
  });
});

describe("the audit rows the controls leave", () => {
  it("are marked as kit's own controls, not an agent's refusals", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-control-rows-"));
    const before = process.cwd();
    process.chdir(dir);
    t.after(() => {
      process.chdir(before);
      rmTemp(dir);
    });
    proveFloor();
    const rows = readFileSync(join(dir, ".kit-audit.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { operation: string; metadata?: { session_id?: string } });
    assert.deepEqual(rows.map((r) => r.operation).sort(), ["gate-bash", "gate-env"]);
    for (const r of rows) assert.equal(r.metadata?.session_id, NEGATIVE_CONTROL_SESSION);
  });
});
