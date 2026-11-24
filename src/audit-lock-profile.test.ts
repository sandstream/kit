import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const probe = fileURLToPath(new URL("../scripts/c6c5-lock-probe.mjs", import.meta.url));
const dist = fileURLToPath(new URL("./", import.meta.url));

test(
  "reports audit-lock timing and preserves the recorded chain",
  { timeout: 170_000 },
  async (t) => {
    const { stdout } = await promisify(execFile)(process.execPath, [probe, "run", dist], {
      timeout: 150_000,
      maxBuffer: 256 * 1024,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.platform, process.platform);
    assert.equal(report.output.length, 3);
    assert.deepEqual(
      report.output.map((round: { writers: number; waitMs: number }) => [
        round.writers,
        round.waitMs,
      ]),
      [
        [8, 5000],
        [24, 5000],
        [24, 30_000],
      ],
    );
    t.diagnostic(stdout.trim());
    const round = report.output[1];
    assert.equal(round.success, 48);
    assert.equal(round.locksTimedOut, 0);
    assert.deepEqual(round.chain, { ok: true, entries: 49 });
    assert.equal(round.seal.status, "anchored-ok");
    assert.equal(round.seal.newSinceAnchor, 0);
  },
);
