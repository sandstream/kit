import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONKEY_ROLES,
  buildMonkeyTestPlan,
  parseEnvOutput,
  securityFindings,
  writeMonkeyHarness,
} from "./monkey-test.js";

const roots: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-monkey-"));
  roots.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("monkey-test role matrix", () => {
  it("models kiosk staff as its own role, not as a kiosk bucket", () => {
    assert.ok(MONKEY_ROLES.some((role) => role.id === "staff" && role.label === "Kiosk staff"));
    assert.equal(
      MONKEY_ROLES.some((role) => String(role.id) === "kiosk"),
      false,
    );
    assert.deepEqual(
      MONKEY_ROLES.map((role) => role.id),
      ["public", "customer", "staff", "owner", "superadmin"],
    );
  });
});

describe("monkey-test planning", () => {
  it("detects stack, Playwright, dev server, seed, env, and money provider", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeJson(join(dir, "package.json"), {
      packageManager: "pnpm@10.0.0",
      scripts: {
        dev: "next dev",
        "db:seed": "tsx scripts/seed.ts",
      },
      dependencies: {
        next: "1.0.0",
        stripe: "1.0.0",
        "@supabase/supabase-js": "1.0.0",
      },
      devDependencies: {
        "@playwright/test": "1.0.0",
      },
    });
    writeFileSync(join(dir, ".kit.toml"), 'version = 1\n[secrets]\nstore = "1password"\n');
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    writeFileSync(
      join(dir, "supabase", "migrations", "001.sql"),
      [
        "create table orders (id uuid, tenant_id uuid);",
        "alter table orders enable row level security;",
        "create policy tenant_orders on orders using (auth.uid() is not null);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "webhook.ts"),
      "stripe.webhooks.constructEvent(raw, sig, secret); await db.insert({ event_id: event.id, tenant_id, receipt: true, refund: true, journal: 'append-only' });",
    );

    const plan = await buildMonkeyTestPlan(dir);

    assert.equal(plan.packageManager, "pnpm");
    assert.equal(plan.playwright.dependency, true);
    assert.equal(plan.commands.dev, "pnpm run dev");
    assert.equal(plan.commands.seed, "pnpm run db:seed");
    assert.equal(plan.env.kitSecrets, true);
    assert.deepEqual(plan.money.providers, ["stripe"]);
    assert.equal(plan.checks.find((check) => check.name === "test runner")?.status, "pass");
  });

  it("prefers specific browser test scripts over generic unit test scripts", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      packageManager: "pnpm@10.0.0",
      scripts: {
        dev: "vite --host 127.0.0.1",
        test: "vitest run",
        e2e: "playwright test",
      },
      dependencies: {
        vite: "1.0.0",
      },
      devDependencies: {
        "@playwright/test": "1.0.0",
      },
    });

    const plan = await buildMonkeyTestPlan(dir);

    assert.equal(plan.commands.test, "pnpm run e2e");
  });

  it("marks runtime live payment credentials as not sandbox-only without leaking the value", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      dependencies: {
        stripe: "1.0.0",
      },
    });
    const envName = "STRIPE_SECRET_KEY_FOR_KIT_MONKEY_TEST";
    const previous = process.env[envName];
    process.env[envName] = "sk_live_runtime_secret_for_test";
    try {
      const plan = await buildMonkeyTestPlan(dir);

      assert.equal(plan.money.sandboxOnly, false);
      assert.ok(
        plan.findings.some(
          (finding) => finding.title === `Live payment credential in runtime env (${envName})`,
        ),
      );
      assert.ok(
        plan.findings.every(
          (finding) => !finding.repro.includes("sk_live_runtime_secret_for_test"),
        ),
      );
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("ignores docs and test fixtures when deciding whether a repo is a money app", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeJson(join(dir, "package.json"), {
      scripts: {
        dev: "vite --host 127.0.0.1",
      },
      dependencies: {
        typescript: "1.0.0",
      },
    });
    writeFileSync(join(dir, "docs", "payments.md"), "Stripe Checkout docs example\n");
    writeFileSync(
      join(dir, "src", "payments.test.ts"),
      "stripe.webhooks.constructEvent(raw, sig, secret);",
    );

    const plan = await buildMonkeyTestPlan(dir);

    assert.deepEqual(plan.money.providers, []);
    assert.equal(plan.checks.find((check) => check.name === "money provider")?.status, "warn");
    assert.equal(
      plan.findings.some((finding) => finding.title.includes("Payment provider detected")),
      false,
    );
  });

  it("detects runtime payment SDK imports even when dependencies are incomplete", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeJson(join(dir, "package.json"), {
      scripts: {
        dev: "vite --host 127.0.0.1",
      },
      dependencies: {},
    });
    writeFileSync(join(dir, "src", "payments.ts"), 'import Stripe from "stripe";\n');

    const plan = await buildMonkeyTestPlan(dir);

    assert.deepEqual(plan.money.providers, ["stripe"]);
  });
});

describe("monkey-test security pack", () => {
  it("surfaces payment authz, webhook, public bucket, and live-key risks", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeJson(join(dir, "package.json"), {
      dependencies: {
        stripe: "1.0.0",
        "@supabase/supabase-js": "1.0.0",
      },
    });
    writeFileSync(
      join(dir, "src", "checkout.ts"),
      "export const key = 'sk_live_1234567890abcdef';",
    );
    writeFileSync(
      join(dir, "supabase", "storage.ts"),
      "createBucket('receipts', { public: true });",
    );

    const findings = await securityFindings(dir);
    const titles = findings.map((finding) => finding.title);

    assert.ok(titles.includes("Committed live payment key pattern"));
    assert.ok(titles.includes("Payment provider detected without webhook signature verification"));
    assert.ok(titles.includes("Payment webhook path lacks obvious idempotency ledger"));
    assert.ok(titles.includes("Public storage bucket declaration"));
    assert.ok(titles.includes("Money app lacks obvious tenant/org isolation markers"));
    assert.equal(findings[0].severity, "critical");
    assert.ok(
      findings.every((finding) => !finding.repro.includes("sk_live_1234567890abcdef")),
      "reports key class, not the secret value",
    );
  });
});

describe("monkey-test harness writer", () => {
  it("creates managed Playwright harness files and updates them idempotently", async () => {
    const dir = tempRepo();
    const first = await writeMonkeyHarness(dir);
    assert.equal(first.ok, true);
    assert.ok(first.writes.every((write) => write.action === "created"));
    assert.equal(existsSync(join(dir, "playwright.monkey.config.ts")), true);
    assert.equal(existsSync(join(dir, "tests", "monkey", "monkey.spec.ts")), true);

    const config = readFileSync(join(dir, "playwright.monkey.config.ts"), "utf-8");
    assert.match(config, /desktop-chromium|mobile-chrome/s);
    assert.match(config, /Number\.isFinite\(rawPort\)/);
    const spec = readFileSync(join(dir, "tests", "monkey", "monkey.spec.ts"), "utf-8");
    assert.match(spec, /MONKEY_MONEY_ROUTE/);
    assert.match(spec, /Kiosk staff/);

    const roles = JSON.parse(
      readFileSync(join(dir, ".kit", "monkey-test", "role-matrix.json"), "utf-8"),
    ) as { roles: { id: string; label: string }[] };
    assert.ok(roles.roles.some((role) => role.id === "staff" && role.label === "Kiosk staff"));

    const second = await writeMonkeyHarness(dir);
    assert.equal(second.ok, true);
    assert.ok(second.writes.every((write) => write.action === "unchanged"));
  });

  it("does not overwrite unmanaged files unless forced", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "playwright.monkey.config.ts"), "custom\n");
    const result = await writeMonkeyHarness(dir);
    assert.equal(result.ok, false);
    const config = result.writes.find((write) => write.path === "playwright.monkey.config.ts");
    assert.equal(config?.action, "skipped");
    assert.equal(readFileSync(join(dir, "playwright.monkey.config.ts"), "utf-8"), "custom\n");
  });
});

describe("monkey-test env parsing", () => {
  it("accepts JSON or dotenv-style temporary env without writing .env files", () => {
    assert.deepEqual(parseEnvOutput('{"A":"one","B":2}'), { A: "one", B: "2" });
    assert.deepEqual(parseEnvOutput("A=one\n# skip\nB='two'\n"), { A: "one", B: "two" });
  });
});
