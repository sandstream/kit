import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MONKEY_ROLES, validateRoleMatrix } from "./monkey-test-contract.js";
import { runnerRoleMatrixFinding, validatePlaywrightEvidence } from "./monkey-test-evidence.js";
import { writeMonkeyHarness } from "./monkey-test-harness.js";
import { buildMonkeyTestPlan } from "./monkey-test-plan.js";
import { runMonkeyTest } from "./monkey-test-runner.js";
import { fixtureCommand, withFixtureEnvironment } from "./monkey-test-runner.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const roots: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-monkey-req-"));
  roots.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

afterEach(() => {
  while (roots.length) rmTemp(roots.pop()!);
});

const publicOnly = {
  configured: true,
  roles: [
    {
      id: "public",
      allowRoutes: ["/"],
      denyRoutes: [],
      requiredText: ["Meetings"],
      forbiddenText: [],
    },
  ],
};

const fullMatrix = {
  configured: true,
  roles: MONKEY_ROLES.map((role) => ({
    id: role.id,
    allowRoutes: ["/"],
    denyRoutes: [`/denied-to-${role.id}`],
    requiredText: [`own-${role.id}`],
    forbiddenText: [`other-${role.id}`],
  })),
};

function tauriRepo(): string {
  const dir = tempRepo();
  writeJson(join(dir, "package.json"), {
    scripts: { dev: "vite dev", tauri: "tauri" },
    dependencies: { "@tauri-apps/api": "2.0.0" },
    devDependencies: { "@tauri-apps/cli": "2.0.0", "@playwright/test": "1.55.0" },
  });
  writeJson(join(dir, "src-tauri", "tauri.conf.json"), {
    productName: "Notes",
    identifier: "com.example.notes",
    build: { devUrl: "http://localhost:1420" },
  });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), 'export const title = "Notes";\n');
  return dir;
}

describe("monkey-test role matrix without roles", () => {
  it("accepts a public-only matrix with no negative controls when roles are not required", () => {
    assert.equal(validateRoleMatrix(publicOnly, false).length, 1);
  });

  it("still requires allowed routes and a positive-control marker", () => {
    const noMarker = { configured: true, roles: [{ ...publicOnly.roles[0], requiredText: [] }] };
    assert.throws(() => validateRoleMatrix(noMarker, false), /requiredText/);
    const noRoute = { configured: true, roles: [{ ...publicOnly.roles[0], allowRoutes: [] }] };
    assert.throws(() => validateRoleMatrix(noRoute, false), /allowRoutes/);
    assert.throws(
      () => validateRoleMatrix({ ...publicOnly, configured: false }, false),
      /configured/,
    );
  });

  it("refuses a public-only matrix when roles are required, and five roles when they are not", () => {
    assert.throws(() => validateRoleMatrix(publicOnly), /exactly once/);
    assert.throws(() => validateRoleMatrix(fullMatrix, false), /exactly once/);
    assert.equal(validateRoleMatrix(fullMatrix).length, MONKEY_ROLES.length);
  });
});

describe("monkey-test plan detects desktop apps", () => {
  it("detects a Tauri app, its identity, dev URL, real data folder, and drivers", async () => {
    const plan = await buildMonkeyTestPlan(tauriRepo());
    assert.ok(plan.desktop, "desktop app detected");
    assert.equal(plan.desktop.framework, "tauri");
    assert.equal(plan.desktop.config, "src-tauri/tauri.conf.json");
    assert.equal(plan.desktop.identifier, "com.example.notes");
    assert.equal(plan.desktop.productName, "Notes");
    assert.equal(plan.desktop.devUrl, "http://localhost:1420");
    assert.ok(plan.desktop.drivers.includes("eval-hook"));
    assert.ok(plan.desktop.realDataDirs.length >= 2);
    for (const dir of plan.desktop.realDataDirs) assert.ok(dir.startsWith(homedir()), dir);
    assert.ok(plan.desktop.realDataDirs.some((dir) => dir.endsWith("com.example.notes")));
    assert.ok(plan.desktop.realDataDirs.some((dir) => dir.endsWith("Notes")));
    if (process.platform === "darwin") {
      assert.equal(plan.desktop.drivers.includes("tauri-driver"), false, "no WKWebView driver");
    } else {
      assert.ok(plan.desktop.drivers.includes("tauri-driver"));
    }
    const check = plan.checks.find((entry) => entry.name === "desktop");
    assert.equal(check?.status, "pass");
    assert.match(check?.detail ?? "", /Tauri/);
    assert.ok(plan.nextSteps.some((step) => /temporary data folder/i.test(step)));
  });

  it("detects an Electron app from its dependency and builder config", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      name: "clipper",
      productName: "Clipper",
      main: "main.js",
      scripts: { start: "electron ." },
      devDependencies: { electron: "33.0.0" },
      build: { appId: "com.example.clipper" },
    });
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.desktop?.framework, "electron");
    assert.equal(plan.desktop?.config, "package.json");
    assert.equal(plan.desktop?.identifier, "com.example.clipper");
    assert.equal(plan.desktop?.productName, "Clipper");
    assert.equal(plan.desktop?.drivers[0], "playwright-electron");
    assert.ok(plan.desktop?.realDataDirs.some((path) => path.endsWith("Clipper")));
  });

  it("reports no desktop app for a plain web app", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), { scripts: { dev: "vite" } });
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.desktop, null);
    assert.equal(
      plan.checks.some((entry) => entry.name === "desktop"),
      false,
    );
  });
});

describe("monkey-test security pack for desktop apps", () => {
  it("accepts the CSP a Tauri app declares in its config, but not a null one", async () => {
    const dir = tauriRepo();
    writeJson(join(dir, "package.json"), {
      scripts: { dev: "vite dev" },
      dependencies: { "@tauri-apps/api": "2.0.0", svelte: "5.0.0" },
    });
    const config = (csp: string | null) => ({
      productName: "Notes",
      identifier: "com.example.notes",
      app: { security: { csp } },
    });
    const cspTitle = "CSP/header policy not found";
    writeJson(join(dir, "src-tauri", "tauri.conf.json"), config(null));
    const without = await buildMonkeyTestPlan(dir);
    assert.ok(without.findings.some((finding) => finding.title === cspTitle));

    writeJson(join(dir, "src-tauri", "tauri.conf.json"), config("default-src 'self'"));
    const declared = await buildMonkeyTestPlan(dir);
    assert.equal(
      declared.findings.some((finding) => finding.title === cspTitle),
      false,
    );
  });
});

describe("monkey-test plan applies role and money requirements only when they exist", () => {
  it("does not require roles or money for an app without auth or payment markers", async () => {
    const plan = await buildMonkeyTestPlan(tauriRepo());
    assert.equal(plan.requirements.roles.required, false);
    assert.equal(plan.requirements.money.required, false);
    assert.match(
      plan.checks.find((entry) => entry.name === "role matrix")?.detail ?? "",
      /public role only/,
    );
    assert.equal(plan.checks.find((entry) => entry.name === "money provider")?.status, "skip");
    assert.ok(!plan.nextSteps.some((step) => step.includes("MONKEY_MONEY_ROUTE")));
  });

  it("requires roles when the app depends on an auth library", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), { dependencies: { "next-auth": "5.0.0" } });
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.requirements.roles.required, true);
    assert.match(plan.requirements.roles.reason, /next-auth/);
    assert.equal(plan.requirements.money.required, false);
    assert.match(
      plan.checks.find((entry) => entry.name === "role matrix")?.detail ?? "",
      /every role/,
    );
  });

  it("requires roles when runtime source checks a role", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {});
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "guard.ts"), 'if (user.role === "admin") allow();\n');
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.requirements.roles.required, true);
  });

  it("sees app source past a large Rust or SvelteKit build folder", async () => {
    const dir = tauriRepo();
    for (const build of [join("src-tauri", "target", "debug"), ".svelte-kit"]) {
      mkdirSync(join(dir, build), { recursive: true });
      for (let index = 0; index < 600; index++) {
        writeFileSync(join(dir, build, `build-${index}.json`), "{}");
      }
    }
    mkdirSync(join(dir, "aa-src"));
    writeFileSync(join(dir, "aa-src", "guard.ts"), 'if (user.role === "admin") allow();\n');
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.requirements.roles.required, true, plan.requirements.roles.reason);
  });
});

describe("monkey-test plan keeps the full gate for payments and declared roles", () => {
  it("requires roles and money for a payment app", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), { dependencies: { stripe: "18.0.0" } });
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.requirements.money.required, true);
    assert.equal(plan.requirements.roles.required, true);
    assert.match(plan.requirements.roles.reason, /money flow/);
    assert.equal(plan.checks.find((entry) => entry.name === "money provider")?.status, "pass");
  });

  it("keeps roles required when the role matrix declares them, or cannot be read", async () => {
    const declared = tauriRepo();
    writeJson(join(declared, ".kit", "monkey-test", "role-matrix.json"), fullMatrix);
    const fromMatrix = await buildMonkeyTestPlan(declared);
    assert.equal(fromMatrix.requirements.roles.required, true);
    assert.match(fromMatrix.requirements.roles.reason, /role matrix/);
    assert.equal(fromMatrix.checks.find((entry) => entry.name === "role matrix")?.status, "pass");

    const broken = tauriRepo();
    mkdirSync(join(broken, ".kit", "monkey-test"), { recursive: true });
    writeFileSync(join(broken, ".kit", "monkey-test", "role-matrix.json"), "{");
    const unreadable = await buildMonkeyTestPlan(broken);
    assert.equal(unreadable.requirements.roles.required, true);
  });

  it("accepts a configured public-only matrix for an app without roles", async () => {
    const dir = tauriRepo();
    writeJson(join(dir, ".kit", "monkey-test", "role-matrix.json"), publicOnly);
    const plan = await buildMonkeyTestPlan(dir);
    assert.equal(plan.requirements.roles.required, false);
    assert.equal(plan.checks.find((entry) => entry.name === "role matrix")?.status, "pass");
  });
});

describe("monkey-test init writes the matrix the app needs", () => {
  it("writes a public-only matrix for an app without roles", async () => {
    const dir = tauriRepo();
    await writeMonkeyHarness(dir);
    const matrix = JSON.parse(
      readFileSync(join(dir, ".kit", "monkey-test", "role-matrix.json"), "utf8"),
    ) as { configured: boolean; roles: { id: string; denyRoutes: string[] }[] };
    assert.equal(matrix.configured, false);
    assert.deepEqual(
      matrix.roles.map((role) => role.id),
      ["public"],
    );
    assert.deepEqual(matrix.roles[0].denyRoutes, []);
  });

  it("writes every role for an app with auth", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), { dependencies: { "@clerk/nextjs": "6.0.0" } });
    await writeMonkeyHarness(dir);
    const matrix = JSON.parse(
      readFileSync(join(dir, ".kit", "monkey-test", "role-matrix.json"), "utf8"),
    ) as { roles: { id: string }[] };
    assert.deepEqual(
      matrix.roles.map((role) => role.id),
      MONKEY_ROLES.map((role) => role.id),
    );
  });
});

describe("monkey-test runner role matrix follows the requirement", () => {
  it("accepts a public-only matrix only when roles are not required", async () => {
    const dir = tempRepo();
    writeJson(join(dir, ".kit", "monkey-test", "role-matrix.json"), publicOnly);
    assert.equal(await runnerRoleMatrixFinding(dir, {}, false), null);
    assert.equal((await runnerRoleMatrixFinding(dir, {}))?.title, "Monkey role matrix invalid");
  });
});

async function runWithEnvDump(
  dir: string,
  envCommand?: string,
): Promise<{ findings: string[]; env: Record<string, string> }> {
  const playwright = join(dir, "node_modules", "@playwright", "test");
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, "package.json"), '{"name":"@playwright/test","main":"index.js"}');
  writeFileSync(join(playwright, "index.js"), "module.exports = {};\n");
  const dump = fixtureCommand(
    dir,
    "dump-env",
    `import { writeFileSync } from "node:fs";
writeFileSync("env.json", JSON.stringify({
  roles: process.env.MONKEY_ROLES_REQUIRED,
  money: process.env.MONKEY_MONEY_REQUIRED,
}));`,
  );
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await withFixtureEnvironment(dir, () =>
      runMonkeyTest(dir, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        skipSecurity: true,
        skipSeed: true,
        expectedReason: "Focused requirement fixture for the runner.",
        testCommand: dump,
        envCommand,
      }),
    );
    return {
      findings: result.findings.map((finding) => finding.title),
      env: JSON.parse(readFileSync(join(dir, "env.json"), "utf8")) as Record<string, string>,
    };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe("monkey-test runner passes the plan's requirements to the browser gate", () => {
  it("tells the spec that an app without roles or payments needs only the public crawl", async () => {
    const dir = tauriRepo();
    await writeMonkeyHarness(dir);
    writeJson(join(dir, ".kit", "monkey-test", "role-matrix.json"), publicOnly);
    const { findings, env } = await runWithEnvDump(dir);
    assert.deepEqual(env, { roles: "0", money: "0" });
    assert.equal(findings.includes("Monkey role matrix invalid"), false, findings.join("\n"));
  });

  it("ignores requirement variables from the temporary env command", async () => {
    const dir = tempRepo();
    writeJson(join(dir, "package.json"), {
      dependencies: { stripe: "18.0.0" },
      devDependencies: { "@playwright/test": "1.55.0" },
    });
    await writeMonkeyHarness(dir);
    writeJson(join(dir, ".kit", "monkey-test", "role-matrix.json"), fullMatrix);
    const provider = fixtureCommand(
      dir,
      "provider",
      'console.log("MONKEY_ROLES_REQUIRED=0\\nMONKEY_MONEY_REQUIRED=0");',
    );
    const { env } = await runWithEnvDump(dir, provider);
    assert.deepEqual(env, { roles: "1", money: "1" });
  });
});

type CaseTest = {
  projectName: string;
  expectedStatus: string;
  status: string;
  results: { status: string }[];
};

function writeReport(dir: string, roleIds: string[], money: boolean): void {
  const projects = ["desktop-chromium", "mobile-chrome"];
  const tests = (): CaseTest[] =>
    projects.map((projectName) => ({
      projectName,
      expectedStatus: "passed",
      status: "expected",
      results: [{ status: "passed" }],
    }));
  const suites = MONKEY_ROLES.filter((role) => roleIds.includes(role.id)).map((role) => ({
    title: `${role.id}: ${role.label}`,
    specs: [{ title: "route crawl", tests: tests() }],
  }));
  if (money) {
    suites.push({ title: "customer payment", specs: [{ title: "money flow", tests: tests() }] });
  }
  writeJson(join(dir, ".kit", "monkey-test", "playwright-report.json"), {
    config: { metadata: { kitMonkeyContract: 1, kitMonkeyRunId: "run-1" } },
    suites: [{ title: "monkey.spec.ts", suites }],
    errors: [],
    stats: { expected: suites.length * 2, unexpected: 0, skipped: 0, flaky: 0 },
  });
}

describe("monkey-test evidence follows the requirement", () => {
  const none = {
    roles: { required: false, reason: "none" },
    money: { required: false, reason: "none" },
  };
  const rolesOnly = { ...none, roles: { required: true, reason: "auth" } };
  const full = { roles: { required: true, reason: "x" }, money: { required: true, reason: "x" } };

  it("accepts a public crawl on both viewports for an app without roles or money", async () => {
    const dir = tempRepo();
    writeReport(dir, ["public"], false);
    assert.deepEqual(await validatePlaywrightEvidence(dir, "run-1", none), {
      ok: true,
      detail: "2 Playwright contract case(s) verified",
    });
    assert.equal((await validatePlaywrightEvidence(dir, "run-1", full)).ok, false);
    assert.equal((await validatePlaywrightEvidence(dir, "run-1")).ok, false, "defaults to full");
  });

  it("requires every role but no money flow for an app with roles and no payments", async () => {
    const dir = tempRepo();
    writeReport(
      dir,
      MONKEY_ROLES.map((role) => role.id),
      false,
    );
    assert.equal((await validatePlaywrightEvidence(dir, "run-1", rolesOnly)).ok, true);
    assert.equal((await validatePlaywrightEvidence(dir, "run-1", none)).ok, false, "extra roles");
  });

  it("still requires the money flow when money is required", async () => {
    const dir = tempRepo();
    writeReport(
      dir,
      MONKEY_ROLES.map((role) => role.id),
      false,
    );
    const result = await validatePlaywrightEvidence(dir, "run-1", full);
    assert.equal(result.ok, false);
    assert.match(result.detail, /money flow/);
  });
});
