import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildMonkeyTestPlan } from "./monkey-test-plan.js";

it("does not activate the money pack from source comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-plan-comments-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "no-payments" }));
    await writeFile(
      join(root, "src", "app.ts"),
      [
        "// TODO: new Stripe(key) when payments are added",
        "/* AdyenCheckout(config); new Braintree(); new Square(); */",
        'export const appName = "Status";',
      ].join("\n"),
    );

    const plan = await buildMonkeyTestPlan(root);
    assert.deepEqual(plan.money.providers, []);
    assert.deepEqual(
      plan.findings.filter((finding) => finding.area === "money"),
      [],
    );
    assert.ok(!plan.nextSteps.some((step) => step.includes("MONKEY_MONEY_ROUTE")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps payment gates for real source markers, SDK URLs, and dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-plan-providers-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), "{}");
    for (const [provider, source] of [
      ["stripe", "new Stripe(key);"],
      ["stripe", 'import Stripe from "stripe";'],
      ["stripe", 'const sdk = "https://js.stripe.com/v3/";'],
      ["adyen", "AdyenCheckout(config);"],
      ["paypal", 'const sdk = "https://www.paypal.com/sdk/js";'],
      ["square", 'const sdk = "https://connect.squareupsandbox.com/sdk";'],
    ]) {
      await writeFile(join(root, "src", "app.ts"), source);
      const plan = await buildMonkeyTestPlan(root);
      assert.deepEqual(plan.money.providers, [provider], source);
      assert.ok(
        plan.findings.some(
          (finding) =>
            finding.severity === "critical" &&
            finding.title === "Payment provider detected without webhook signature verification",
        ),
        source,
      );
    }
    await writeFile(join(root, "src", "app.ts"), "// new Stripe(key);");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { stripe: "1.0.0" } }),
    );
    const plan = await buildMonkeyTestPlan(root);
    assert.deepEqual(plan.money.providers, ["stripe"]);
    assert.ok(plan.findings.some((finding) => finding.area === "money"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("still flags committed live keys inside source comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-monkey-plan-comment-secret-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), `// sk_live_${"x".repeat(24)}\n`);
    const plan = await buildMonkeyTestPlan(root);
    assert.deepEqual(plan.money.providers, []);
    assert.ok(
      plan.findings.some((finding) => finding.title === "Committed live payment key pattern"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
