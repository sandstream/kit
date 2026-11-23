import assert from "node:assert/strict";
import { it } from "node:test";
import { runAudit } from "./advisory-baseline.js";
import { managerFixture } from "./manager-audit-scope.test-support.js";

for (const manager of ["bun", "pnpm", "yarn"] as const) {
  it(`does not accept a missing ${manager} audit as an empty baseline report`, (t) => {
    const { project, env } = managerFixture(t, manager);
    const run = runAudit(
      project,
      {
        manager,
        command: [
          process.execPath,
          "-e",
          'process.stdout.write(JSON.stringify({message:"audit report missing"}))',
        ],
        versionCommand: [process.execPath, "-e", 'process.stdout.write("4.17.0")'],
      },
      5_000,
      env,
    );
    assert.ok(run.error, "incomplete evidence must block a baseline update");
    assert.equal(run.evidenceStatus, "malformed");
    assert.deepEqual(run.advisories, []);
  });
}
