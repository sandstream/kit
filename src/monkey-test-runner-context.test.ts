import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunContext } from "./monkey-test-runner-context.js";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-monkey-context-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { dev: "node server.js", seed: "node seed.js" } }),
  );
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("initializes a run with detected project commands and isolated execution state", async () => {
  const root = project();
  const first = await createRunContext(root, {
    expectedReason: "sandbox fixture expected to fail",
    timeoutMs: 4_321,
    linkDepth: 4,
  });
  const second = await createRunContext(root, {});
  try {
    assert.equal(first.root, root);
    assert.equal(first.plan.cwd, root);
    assert.equal(first.plan.commands.dev, "npm run dev");
    assert.equal(first.plan.commands.seed, "npm run seed");
    assert.equal(first.hasExpectedReason, true);
    assert.equal(first.expectedReasonRaw, "sandbox fixture expected to fail");
    assert.equal(first.timeoutMs, 4_321);
    assert.equal(second.timeoutMs, 120_000);
    assert.equal(first.env.MONKEY_LINK_DEPTH, "4");
    assert.notEqual(first.env.MONKEY_RUN_ID, second.env.MONKEY_RUN_ID);
    assert.deepEqual(first.findings, []);
    assert.deepEqual(first.steps, []);
  } finally {
    await first.processes.close();
    await second.processes.close();
  }
});
