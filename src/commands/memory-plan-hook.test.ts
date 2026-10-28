import { it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { planCliFixture } from "./memory-plan-fixture.test-support.js";

it("SessionStart puts unfinished plans in agent context and clears the notice on completion", (t) => {
  const { parent, run } = planCliFixture(t);
  const plan = join(parent, "project-session-plan.md");
  writeFileSync(plan, "Status: PROPOSAL\n");
  const first = run(["hook", "session-start"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Open plan files: project-session-plan\.md/);
  assert.match(first.stdout, /actions:1/);
  writeFileSync(plan, "Status: DONE\n");
  const second = run(["hook", "session-start"]);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /Open plan files:/);
  assert.doesNotMatch(second.stdout, /actions:1/);
});
