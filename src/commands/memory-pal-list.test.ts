import { it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { planCliFixture } from "./memory-plan-fixture.test-support.js";

it("PAL list creates a stable item for a plan and closes it only after completion", (t) => {
  const { parent, run, exists } = planCliFixture(t);
  const list = (extra: Record<string, string> = {}) => {
    const result = run(["pal", "list", "--json"], extra);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { id: string; title: string; detail: string }[];
  };
  assert.deepEqual(list(), []);
  assert.equal(exists(), false);
  const plan = join(parent, "project-release-plan.md");
  writeFileSync(plan, "Status: PROPOSAL\n");
  const [item] = list();
  assert.ok(item);
  assert.match(item.title, /project-release-plan/);
  assert.equal(list()[0]?.id, item.id);
  unlinkSync(plan);
  assert.match(list()[0]?.detail ?? "", /source missing/);
  writeFileSync(plan, "Status: DONE\n");
  assert.deepEqual(list(), []);
  writeFileSync(join(parent, "project-new-plan.md"), "Status: PROPOSAL\n");
  assert.deepEqual(list({ KIT_READ_ONLY: "1" }), []);
});
