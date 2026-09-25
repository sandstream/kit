import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONKEY_ROLES,
  runMonkeyTest as executeMonkeyTest,
  validateMoneyFlowConfig,
  writeMonkeyHarness,
} from "./monkey-test.js";
import {
  fixtureCommand,
  markerCommand,
  shellQuote,
  withFixtureEnvironment,
} from "./monkey-test-runner.test-support.js";
import { providerCommand } from "./monkey-test-runner-env.test-support.js";

const runMonkeyTest = (root: string, options?: Parameters<typeof executeMonkeyTest>[1]) =>
  withFixtureEnvironment(root, () => executeMonkeyTest(root, options));

const roots: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-monkey-"));
  roots.push(dir);
  const playwrightModule = join(dir, "node_modules", "@playwright", "test");
  mkdirSync(playwrightModule, { recursive: true });
  writeFileSync(
    join(playwrightModule, "package.json"),
    '{"name":"@playwright/test","main":"index.js"}\n',
  );
  writeFileSync(join(playwrightModule, "index.js"), "module.exports = {};\n");
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function configureRoleMatrix(dir: string): void {
  writeJson(join(dir, ".kit", "monkey-test", "role-matrix.json"), {
    configured: true,
    roles: MONKEY_ROLES.map((role) => ({
      id: role.id,
      allowRoutes: ["/"],
      denyRoutes: [`/denied-to-${role.id}`],
      requiredText: [`own-org-${role.id}`],
      forbiddenText: [`other-org-${role.id}`],
    })),
  });
}

function writeValidReportScript(dir: string): string {
  const name = "write-report.mjs";
  writeFileSync(
    join(dir, name),
    `import { writeFileSync } from "node:fs";
const projects = ["desktop-chromium", "mobile-chrome"];
const roles = ${JSON.stringify(MONKEY_ROLES.map(({ id, label }) => ({ id, label })))};
// A genuinely passing case, as Playwright records one: expectations matched, the
// expectation WAS "passed", and an attempt passed. "expected" alone is also what a
// test.fail() spec reports (MHB-03), so it is not evidence on its own.
const tests = () => projects.map((projectName) => ({
  projectName,
  expectedStatus: "passed",
  status: "expected",
  results: [{ status: "passed" }],
}));
const suites = roles.map((role) => ({
  title: role.id + ": " + role.label,
  specs: [{ title: "route crawl", tests: tests() }],
}));
suites.push({ title: "customer payment", specs: [{ title: "money flow", tests: tests() }] });
writeFileSync(".kit/monkey-test/playwright-report.json", JSON.stringify({
  config: { metadata: { kitMonkeyContract: 1, kitMonkeyRunId: process.env.MONKEY_RUN_ID } },
  suites: [{ title: "monkey.spec.ts", suites }],
  errors: [],
  stats: { expected: 10, unexpected: 0, skipped: 0, flaky: 0 },
}));
`,
  );
  return name;
}

function captureOutput(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const capture = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  (process.stdout as unknown as { write: unknown }).write = capture;
  (process.stderr as unknown as { write: unknown }).write = capture;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
  };
}

afterEach(() => {
  while (roots.length)
    rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("monkey-test money flow contract", () => {
  it("requires explicit sandbox evidence and post-action state selectors", () => {
    const base = {
      MONKEY_MONEY_ROUTE: "/shop",
      MONKEY_ADD_TO_CART: "[data-add]",
      MONKEY_CHECKOUT: "[data-checkout]",
      MONKEY_PAYMENT_SHELL: "[data-payment-shell]",
      MONKEY_SANDBOX_INDICATOR: '[data-payment-mode="test"]',
    };

    assert.throws(
      () => validateMoneyFlowConfig({ ...base, MONKEY_PAYMENT_MODE: "live" }),
      /test or sandbox/,
    );
    assert.throws(
      () => validateMoneyFlowConfig({ ...base, MONKEY_PAYMENT_MODE: "test" }),
      /MONKEY_CANCEL_PAYMENT.*MONKEY_CANCELLED_STATE/,
    );
    assert.deepEqual(
      validateMoneyFlowConfig({
        ...base,
        MONKEY_PAYMENT_MODE: "sandbox",
        MONKEY_PAYMENT_ACTION: "confirm",
        MONKEY_CONFIRM_PAYMENT: "[data-confirm]",
        MONKEY_CONFIRMED_STATE: "[data-paid]",
      }),
      {
        mode: "sandbox",
        action: "confirm",
        route: "/shop",
        addToCart: "[data-add]",
        checkout: "[data-checkout]",
        paymentShell: "[data-payment-shell]",
        sandboxIndicator: '[data-payment-mode="test"]',
        actionControl: "[data-confirm]",
        finalState: "[data-paid]",
      },
    );
  });

  it("rejects document-wide selectors as payment evidence (MHB-09)", () => {
    assert.throws(
      () =>
        validateMoneyFlowConfig({
          MONKEY_PAYMENT_MODE: "sandbox",
          MONKEY_PAYMENT_ACTION: "cancel",
          MONKEY_MONEY_ROUTE: "/shop",
          MONKEY_ADD_TO_CART: "#add",
          MONKEY_CHECKOUT: "#checkout",
          MONKEY_PAYMENT_SHELL: "body",
          MONKEY_SANDBOX_INDICATOR: "body",
          MONKEY_CANCEL_PAYMENT: "body",
          MONKEY_CANCELLED_STATE: "body",
        }),
      /specific DOM selector/,
    );
  });

  it("requires independent selectors for payment stages (MHB-09)", () => {
    assert.throws(
      () =>
        validateMoneyFlowConfig({
          MONKEY_PAYMENT_MODE: "sandbox",
          MONKEY_PAYMENT_ACTION: "cancel",
          MONKEY_MONEY_ROUTE: "/shop",
          MONKEY_ADD_TO_CART: "#add",
          MONKEY_CHECKOUT: "#checkout",
          MONKEY_PAYMENT_SHELL: "[data-payment]",
          MONKEY_SANDBOX_INDICATOR: "[data-payment]",
          MONKEY_CANCEL_PAYMENT: "[data-payment]",
          MONKEY_CANCELLED_STATE: "[data-payment]",
        }),
      /distinct DOM selectors/,
    );
  });
});

describe("monkey-test runner gate prerequisites", () => {
  it("validates prerequisites and runs seed when security and browser are explicitly skipped", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });

    const result = await runMonkeyTest(dir, {
      skipSecurity: true,
      skipBrowser: true,
      expectedReason: "Focused release exception while browser infrastructure is unavailable.",
      seedCommand: markerCommand(dir, "seed"),
    });

    assert.equal(existsSync(join(dir, "seed.ran")), true, "seed command was bypassed");
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((item) => item.title === "Monkey harness incomplete"),
      JSON.stringify(result.findings, null, 2),
    );
    assert.ok(result.findings.some((item) => item.title === "Monkey role matrix invalid"));
    assert.ok(result.steps.some((step) => step.name === "seed" && step.status === "pass"));
  });

  it("rejects an unconfigured role matrix even when browser execution is skipped", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);

    const result = await runMonkeyTest(dir, {
      skipSecurity: true,
      skipBrowser: true,
      expectedReason: "Focused release exception while browser infrastructure is unavailable.",
      seedCommand: fixtureCommand(dir, "seed", "process.exit(0);"),
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((item) => item.title === "Monkey role matrix invalid"),
      JSON.stringify(result.findings, null, 2),
    );
  });

  it("keeps the release gate red when browser execution is explicitly skipped", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);

    const result = await runMonkeyTest(dir, {
      skipSecurity: true,
      skipBrowser: true,
      expectedReason: "Browser infrastructure outage recorded by release owner.",
      seedCommand: fixtureCommand(dir, "seed", "process.exit(0);"),
    });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((item) => item.title === "Browser evidence skipped"));
  });
});

describe("monkey-test runner gate redaction", () => {
  it("redacts provider failures and refuses seed after env loading fails", async () => {
    const dir = tempRepo();
    const inlineSecret = "ghp_" + "S".repeat(36);
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    writeFileSync(join(dir, "provider-error"), inlineSecret);
    const capture = captureOutput();

    try {
      const result = await runMonkeyTest(dir, {
        skipSecurity: true,
        skipBrowser: true,
        expectedReason: "Runner redaction regression with browser intentionally unavailable.",
        envCommand: fixtureCommand(
          dir,
          "env",
          'import { readFileSync } from "node:fs"; process.stderr.write(readFileSync("provider-error", "utf8")); process.exit(1);',
        ),
        seedCommand: markerCommand(dir, "seed"),
      });
      const surfaced = `${capture.output()}\n${JSON.stringify(result)}`;

      assert.ok(!surfaced.includes(inlineSecret), "provider command/error leaked a credential");
      assert.equal(existsSync(join(dir, "seed.ran")), false);
      assert.ok(result.steps.some((step) => step.name === "seed" && step.status === "skip"));
    } finally {
      capture.restore();
    }
  });

  it("redacts streamed seed output loaded from the temporary environment", async () => {
    const dir = tempRepo();
    const opaqueSecret = "opaque-monkey-secret-" + "T".repeat(24);
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    const capture = captureOutput();

    try {
      const result = await runMonkeyTest(dir, {
        skipSecurity: true,
        skipBrowser: true,
        expectedReason: "Runner redaction regression with browser intentionally unavailable.",
        envCommand: providerCommand(dir, JSON.stringify({ MONKEY_TEST_SECRET: opaqueSecret })),
        seedCommand: fixtureCommand(
          dir,
          "seed",
          'process.stdout.write("seed " + process.env.MONKEY_TEST_SECRET);',
        ),
      });
      const surfaced = `${capture.output()}\n${JSON.stringify(result)}`;

      assert.ok(!surfaced.includes(opaqueSecret), "streamed seed output leaked an env secret");
      assert.match(surfaced, /\[REDACTED\]/);
      assert.ok(result.steps.some((step) => step.name === "seed" && step.status === "pass"));
    } finally {
      capture.restore();
    }
  });
});

describe("monkey-test runner payment safety", () => {
  it("refuses live payment env before seed or browser side effects", async () => {
    const dir = tempRepo();
    const liveKey = `sk_live_${"L".repeat(32)}`;
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);

    const result = await runMonkeyTest(dir, {
      skipSecurity: true,
      expectedReason: "Focused payment safety regression fixture.",
      envCommand: providerCommand(dir, JSON.stringify({ STRIPE_SECRET_KEY: liveKey })),
      seedCommand: markerCommand(dir, "seed"),
      startCommand: markerCommand(dir, "server"),
    });

    assert.equal(existsSync(join(dir, "seed.ran")), false);
    assert.equal(existsSync(join(dir, "server.ran")), false);
    assert.ok(result.findings.some((item) => item.title === "Live payment environment refused"));
    assert.ok(result.steps.some((step) => step.name === "seed" && step.status === "skip"));
    assert.ok(result.steps.some((step) => step.name === "browser" && step.status === "skip"));
  });

  it("refuses a non-Stripe provider production environment before side effects (MHB-05)", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await runMonkeyTest(dir, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        skipSecurity: true,
        expectedReason: "Focused provider production-mode safety regression fixture.",
        envCommand: fixtureCommand(
          dir,
          "env",
          'process.stdout.write(JSON.stringify({PAYPAL_ENVIRONMENT:"production"}));',
        ),
        seedCommand: markerCommand(dir, "seed"),
      });

      assert.equal(existsSync(join(dir, "seed.ran")), false);
      assert.ok(result.findings.some((item) => item.title === "Live payment environment refused"));
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});

describe("monkey-test runner gate missing evidence", () => {
  it("rejects an exit-zero test command without fresh Playwright contract evidence", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await runMonkeyTest(dir, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        skipSecurity: true,
        skipSeed: true,
        expectedReason: "Focused runner-contract regression fixture.",
        testCommand: fixtureCommand(dir, "test", "process.exit(0);"),
      });

      assert.equal(result.ok, false);
      assert.ok(
        result.findings.some((item) => item.title === "Playwright evidence missing or invalid"),
        JSON.stringify(result.findings, null, 2),
      );
      assert.ok(result.steps.some((step) => step.name === "playwright" && step.status === "fail"));
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});

describe("monkey-test runner custom-command evidence (MHB-04)", () => {
  it("rejects a current-run JSON report produced without the generated browser command", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    const reportScript = writeValidReportScript(dir);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await runMonkeyTest(dir, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        skipSecurity: true,
        skipSeed: true,
        expectedReason: "Focused runner-contract regression fixture.",
        testCommand: `${shellQuote(process.execPath)} ${shellQuote(reportScript)}`,
      });

      assert.equal(
        result.ok,
        false,
        "a child that only writes JSON cannot attest browser execution",
      );
      assert.ok(
        result.findings.some(
          (item) => item.title === "Custom test command cannot establish browser evidence",
        ),
        JSON.stringify(result.findings, null, 2),
      );
      assert.ok(result.steps.some((step) => step.name === "playwright" && step.status === "fail"));
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});

describe("monkey-test runner server lifecycle", () => {
  it("kills the full dev-server process group before returning", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    const reportScript = writeValidReportScript(dir);
    writeFileSync(
      join(dir, "stubborn-server.mjs"),
      `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
process.on("SIGTERM", () => {});
createServer((_request, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
writeFileSync("server.pid", String(process.pid));
`,
    );

    try {
      const result = await runMonkeyTest(dir, {
        skipSecurity: true,
        skipSeed: true,
        expectedReason: "Focused runner lifecycle regression fixture.",
        startCommand: `${shellQuote(process.execPath)} ${shellQuote("stubborn-server.mjs")}`,
        testCommand: `${shellQuote(process.execPath)} ${shellQuote(reportScript)}`,
      });

      assert.equal(
        result.findings.some((finding) => finding.title === "Dev server did not stop"),
        false,
        JSON.stringify(result.findings, null, 2),
      );
      await assert.rejects(fetch(result.baseUrl!));
    } finally {
      const pidPath = join(dir, "server.pid");
      if (existsSync(pidPath)) {
        try {
          process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
        } catch {
          // Runner already stopped the process as required.
        }
      }
    }
  });
});

describe("monkey-test runner gate skipped evidence", () => {
  it("rejects Playwright evidence when the required money flow was skipped", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      scripts: {},
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    await writeMonkeyHarness(dir);
    configureRoleMatrix(dir);
    writeFileSync(
      join(dir, "write-skipped-report.mjs"),
      `import { writeFileSync } from "node:fs";
const projects = ["desktop-chromium", "mobile-chrome"];
const roles = ${JSON.stringify(MONKEY_ROLES.map(({ id, label }) => ({ id, label })))};
const expected = () => projects.map((projectName) => ({
  projectName,
  expectedStatus: "passed",
  status: "expected",
  results: [{ status: "passed" }],
}));
const skipped = () => projects.map((projectName) => ({
  projectName,
  status: "skipped",
  annotations: [{ type: "skip", description: "Payment sandbox temporarily unavailable." }],
}));
const suites = roles.map((role) => ({
  title: role.id + ": " + role.label,
  specs: [{ title: "route crawl", tests: expected() }],
}));
suites.push({ title: "customer payment", specs: [{ title: "money flow", tests: skipped() }] });
writeFileSync(".kit/monkey-test/playwright-report.json", JSON.stringify({
  config: { metadata: { kitMonkeyContract: 1, kitMonkeyRunId: process.env.MONKEY_RUN_ID } },
  suites: [{ title: "monkey.spec.ts", suites }],
  errors: [],
}));
`,
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await runMonkeyTest(dir, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        skipSecurity: true,
        skipSeed: true,
        expectedReason: "Focused runner-contract regression fixture.",
        testCommand: `${shellQuote(process.execPath)} ${shellQuote("write-skipped-report.mjs")}`,
      });

      assert.equal(result.ok, false);
      assert.ok(
        result.findings.some((item) => item.title === "Playwright evidence missing or invalid"),
        JSON.stringify(result.findings, null, 2),
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});
