import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  MONKEY_ROLES,
  buildMonkeyTestPlan,
  controlHasAccessibleName,
  focusableIsOffscreen,
  parseEnvOutput,
  securityFindings,
  unexpectedMonkeyFindings,
  validateRoleMatrix,
  writeMonkeyHarness,
  type MonkeyFinding,
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

  it("requires explicit allow, deny, and cross-org expectations for every role", () => {
    const roles = MONKEY_ROLES.map((role) => ({
      id: role.id,
      allowRoutes: ["/"],
      denyRoutes: [`/forbidden-to-${role.id}`],
      requiredText: [`own-org-${role.id}`],
      forbiddenText: [`other-org-${role.id}`],
    }));

    assert.throws(() => validateRoleMatrix({ configured: false, roles }), /configured/);
    assert.equal(validateRoleMatrix({ configured: true, roles }).length, MONKEY_ROLES.length);
    assert.throws(
      () => validateRoleMatrix({ configured: true, roles: roles.slice(1) }),
      /exactly once|public/,
    );

    const noPositiveControl = roles.map((role) => ({ ...role, requiredText: [] }));
    assert.throws(
      () => validateRoleMatrix({ configured: true, roles: noPositiveControl }),
      /requiredText/,
    );

    const placeholders = MONKEY_ROLES.map((role) => ({
      id: role.id,
      allowRoutes: ["/"],
      denyRoutes: [`/replace-with-route-denied-to-${role.id}`],
      requiredText: [`replace-with-seeded-own-org-marker-for-${role.id}`],
      forbiddenText: [`replace-with-seeded-other-org-marker-for-${role.id}`],
    }));
    assert.throws(
      () => validateRoleMatrix({ configured: true, roles: placeholders }),
      /placeholder/,
    );
  });
});

describe("monkey-test planning - stack detection", () => {
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
});

describe("monkey-test planning - command selection", () => {
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
});

describe("monkey-test planning - payment source detection", () => {
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

  it("does not expose an env provider command or its embedded credentials in the plan", async () => {
    const dir = tempRepo();
    const secret = "ghp_" + "R".repeat(36);

    const plan = await buildMonkeyTestPlan(dir, {
      envCommand: `provider export --token ${secret}`,
    });
    const serialized = JSON.stringify(plan);

    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes("provider export"));
    assert.equal(plan.env.envCommand, "provided via --env-command");
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

  it("does not treat comments or checklist keywords as implemented security controls", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeJson(join(dir, "package.json"), {
      dependencies: {
        stripe: "1.0.0",
        "@supabase/supabase-js": "1.0.0",
      },
    });
    writeFileSync(
      join(dir, "src", "checkout.ts"),
      [
        'import Stripe from "stripe";',
        "const stripe = new Stripe(process.env.STRIPE_TEST_KEY ?? 'missing');",
        "export async function checkout() { return stripe.checkout.sessions.create({ mode: 'payment' }); }",
        "export const releaseChecklist = { tenant_id: true, constructEvent: true, idempotency: true, refund: true, receipt: true, immutable: true, journal: true };",
        "/* enable row level security; create policy using (auth.uid());",
        "stripe.webhooks.constructEvent(raw, sig, secret);",
        "insert processed event.id for idempotency; refund receipt immutable journal tenant_id */",
      ].join("\n"),
    );

    const titles = (await securityFindings(dir)).map((item) => item.title);

    for (const title of [
      "Supabase detected without obvious RLS policy coverage",
      "Money app lacks obvious tenant/org isolation markers",
      "Payment provider detected without webhook signature verification",
      "Payment webhook path lacks obvious idempotency ledger",
      "Refund path not found",
      "Receipt path not found",
      "Immutable money journal not found",
    ]) {
      assert.ok(titles.includes(title), `${title}: ${JSON.stringify(titles)}`);
    }
  });

  it("recognizes control-shaped security implementations", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    writeJson(join(dir, "package.json"), {
      dependencies: {
        stripe: "1.0.0",
        "@supabase/supabase-js": "1.0.0",
      },
    });
    writeFileSync(
      join(dir, "supabase", "migrations", "001.sql"),
      [
        "create table orders (id uuid primary key, tenant_id uuid references tenants(id));",
        "alter table orders enable row level security;",
        "create policy tenant_orders on orders using (tenant_id = auth.uid());",
        "create table webhook_events (event_id text unique);",
        "create table journal (id uuid primary key, event jsonb not null);",
        "revoke update, delete on table journal from authenticated;",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "payments.ts"),
      [
        "export async function webhook(raw: string, sig: string, secret: string) {",
        "  const event = stripe.webhooks.constructEvent(raw, sig, secret);",
        "  await processedEvents.insert({ event_id: event.id });",
        "}",
        "export async function refundPayment(id: string) { return stripe.refunds.create({ payment_intent: id }); }",
        "export function receiptFor(charge: { receipt_url: string }) { return charge.receipt_url; }",
        "export async function recordPayment(event: unknown) { await journal.insert({ event }); }",
      ].join("\n"),
    );

    const titles = (await securityFindings(dir)).map((item) => item.title);

    assert.deepEqual(titles, []);
  });

  it("detects non-payment secret shapes in runtime source without echoing the value", async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, "src"), { recursive: true });
    const secret = "ghp_" + "Q".repeat(36);
    writeFileSync(join(dir, "src", "provider.ts"), `export const credential = "${secret}";\n`);

    const findings = await securityFindings(dir);
    const serialized = JSON.stringify(findings);

    assert.ok(findings.some((item) => item.title === "Secret-shaped value in runtime source"));
    assert.ok(!serialized.includes(secret), "finding output must not echo the credential");
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
    const transpiled = ts.transpileModule(spec, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const syntaxErrors = (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    assert.deepEqual(
      syntaxErrors.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
      [],
    );

    const roleMatrix = JSON.parse(
      readFileSync(join(dir, ".kit", "monkey-test", "role-matrix.json"), "utf-8"),
    ) as {
      configured: boolean;
      roles: {
        id: string;
        label: string;
        allowRoutes: string[];
        denyRoutes: string[];
        forbiddenText: string[];
        requiredText: string[];
      }[];
    };
    assert.equal(roleMatrix.configured, false);
    assert.ok(roleMatrix.roles.some((role) => role.id === "staff" && role.label === "Kiosk staff"));
    assert.ok(
      roleMatrix.roles.every(
        (role) =>
          Array.isArray(role.allowRoutes) &&
          Array.isArray(role.denyRoutes) &&
          Array.isArray(role.requiredText) &&
          Array.isArray(role.forbiddenText),
      ),
    );
    assert.match(spec, /validateRoleMatrix/);
    assert.match(spec, /Denied route exposed/);
    assert.match(spec, /Cross-org isolation marker visible/);
    assert.match(spec, /expectedAuthFailure/);

    const second = await writeMonkeyHarness(dir);
    assert.equal(second.ok, true);
    assert.ok(second.writes.every((write) => write.action === "unchanged"));
  });

  it("preserves an operator-owned Playwright configuration", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "playwright.monkey.config.ts"), "custom\n");
    const result = await writeMonkeyHarness(dir);
    assert.equal(result.ok, true);
    const config = result.writes.find((write) => write.path === "playwright.monkey.config.ts");
    assert.equal(config?.action, "unchanged");
    assert.equal(readFileSync(join(dir, "playwright.monkey.config.ts"), "utf-8"), "custom\n");
  });
});

describe("monkey-test env parsing", () => {
  it("accepts JSON or dotenv-style temporary env without writing .env files", () => {
    assert.deepEqual(parseEnvOutput('{"A":"one","B":2}'), { A: "one", B: "2" });
    assert.deepEqual(parseEnvOutput("A=one\n# skip\nB='two'\n"), { A: "one", B: "two" });
  });
});

describe("monkey-test expected findings", () => {
  const publicFinding: MonkeyFinding = {
    severity: "high",
    area: "authz",
    title: "Protected route exposed",
    role: "public",
    route: "/admin",
    repro: "GET /admin returned 200",
    fix: "Deny public access.",
  };
  const customerFinding: MonkeyFinding = { ...publicFinding, role: "customer" };

  it("rejects reason-only rules and scopes valid rules to title, role, and route", () => {
    assert.throws(
      () =>
        unexpectedMonkeyFindings(
          [publicFinding, customerFinding],
          [{ reason: "Accepted temporarily by release owner." }],
        ),
      /title, role, and route/,
    );

    assert.deepEqual(
      unexpectedMonkeyFindings(
        [publicFinding, customerFinding],
        [
          {
            title: "Protected route exposed",
            role: "public",
            route: "/admin",
            reason: "Public maintenance route exception expires after migration.",
          },
        ],
      ),
      [customerFinding],
    );
  });
});

describe("monkey-test accessibility predicates", () => {
  it("honors associated labels and aria-labelledby", () => {
    assert.equal(controlHasAccessibleName({ associatedLabel: "Email address" }), true);
    assert.equal(controlHasAccessibleName({ labelledByText: "Open cart" }), true);
    assert.equal(controlHasAccessibleName({}), false);
  });

  it("ignores ordinary below-fold controls but catches horizontal off-canvas controls", () => {
    assert.equal(
      focusableIsOffscreen({
        left: 20,
        right: 180,
        top: 1_400,
        bottom: 1_440,
        viewportWidth: 390,
        viewportHeight: 844,
        display: "block",
        visibility: "visible",
      }),
      false,
    );
    assert.equal(
      focusableIsOffscreen({
        left: 500,
        right: 620,
        top: 20,
        bottom: 60,
        viewportWidth: 390,
        viewportHeight: 844,
        display: "block",
        visibility: "visible",
      }),
      true,
    );
    assert.equal(
      focusableIsOffscreen({
        left: 20,
        right: 180,
        top: -100,
        bottom: -40,
        viewportWidth: 390,
        viewportHeight: 844,
        display: "block",
        visibility: "visible",
      }),
      true,
    );
  });
});
