import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { runGoverned, runGovernedBrokered, withGovernance } from "./governance-middleware.js";
import {
  governanceConfig,
  governanceFixture,
  seedBudget,
} from "./governance-outcome.test-support.js";

for (const run of [withGovernance, runGoverned, runGovernedBrokered]) {
  it(`${run.name} refuses execution when admission storage fails`, async (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.skip("Expected: this permission fixture requires POSIX and a non-root user.");
      return;
    }
    const { target } = governanceFixture(t);
    const before = seedBudget(target, 0, 0);
    const state = join(target, ".kit-budget.json");
    chmodSync(state, 0o400);
    const operation = async () => {
      writeFileSync(join(target, "operation-ran"), "yes");
      return { success: true };
    };
    const call = () =>
      run(governanceConfig, { operation: "fixture", operationType: "write" }, operation, {
        cwd: target,
        assessResult: (value) => value,
      });
    const message = "Could not save budget usage. Check .kit-budget.json.";
    if (run === withGovernance) await assert.rejects(call, { message });
    else assert.deepEqual(await call(), { ok: false, reason: message });
    chmodSync(state, 0o600);
    assert.equal(existsSync(join(target, "operation-ran")), false);
    assert.equal(readFileSync(state, "utf8"), before);
    const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
    assert.equal(events.length, 1);
    assert.equal(events[0].success, false);
    assert.equal(events[0].error, message);
    assert.equal(events[0].metadata?.phase, undefined);
    assert.equal(events[0].metadata?.operation_success, undefined);
  });
}

for (const run of [withGovernance, runGoverned, runGovernedBrokered]) {
  it(`${run.name} records failed refund and the original thrown outcome`, async (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.skip("Expected: this permission fixture requires POSIX and a non-root user.");
      return;
    }
    const { target } = governanceFixture(t);
    seedBudget(target, 0, 0);
    const state = join(target, ".kit-budget.json");
    const call = () =>
      run(
        governanceConfig,
        { operation: "fixture", operationType: "write", estimatedTokens: 5 },
        async () => {
          writeFileSync(join(target, "operation-ran"), "yes");
          chmodSync(state, 0o400);
          throw new Error("fixture callback threw");
        },
        { cwd: target },
      );
    const message = "Operation failed; could not refund reserved budget.";
    try {
      if (run === withGovernance) await assert.rejects(call, { message });
      else assert.deepEqual(await call(), { ok: false, reason: message });
    } finally {
      chmodSync(state, 0o600);
    }
    assert.equal(readFileSync(join(target, "operation-ran"), "utf8"), "yes");
    const charged = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(charged.operations_this_hour, 1);
    assert.equal(charged.tokens_today, 5);
    const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
    assert.equal(events.length, 1);
    assert.equal(events[0].success, false);
    assert.equal(events[0].error, message);
    assert.equal(events[0].metadata?.phase, "budget-refund-failed");
    assert.equal(events[0].metadata?.operation_success, false);
    assert.equal(events[0].metadata?.operation_error, "fixture callback threw");
  });
}
