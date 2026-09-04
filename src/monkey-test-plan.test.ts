import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildMonkeyTestPlan } from "./monkey-test-plan.js";

describe("monkey-test plan discovery", () => {
  it("detects package manager, runner, server, seed, env, and payment provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-monkey-plan-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.0.0",
          scripts: { dev: "vite", "seed:test": "node seed.js", test: "playwright test" },
          devDependencies: { "@playwright/test": "1.55.0", stripe: "18.0.0" },
        }),
      );
      await writeFile(join(root, ".env.example"), "STRIPE_SECRET_KEY=\n");
      await writeFile(join(root, "src", "app.ts"), 'import Stripe from "stripe";\n');

      const plan = await buildMonkeyTestPlan(root);
      assert.equal(plan.packageManager, "pnpm");
      assert.equal(plan.commands.dev, "pnpm run dev");
      assert.equal(plan.commands.seed, "pnpm run seed:test");
      assert.equal(plan.playwright.dependency, true);
      assert.equal(plan.env.envExample, true);
      assert.deepEqual(plan.money.providers, ["stripe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
