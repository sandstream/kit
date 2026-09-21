import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import { MONKEY_ROLES } from "./monkey-test-contract.js";
import { monkeySpec } from "./monkey-test-harness-spec.js";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-monkey-spec-"));
  roots.push(dir);
  return dir;
}

const PLAYWRIGHT_STUB = `import { writeFileSync } from "node:fs";

const registered = [];
const describeStack = [];

export function test(name) {
  registered.push({ path: [...describeStack], name });
}
test.describe = (name, fn) => {
  describeStack.push(name);
  fn();
  describeStack.pop();
};
test.use = () => {};
test.skip = () => {};

const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain });
export const expect = chain;
export const devices = new Proxy({}, { get: () => ({}) });
export const defineConfig = (config) => config;

process.on("exit", () => {
  writeFileSync(process.env.MONKEY_STUB_OUT, JSON.stringify(registered, null, 2));
});
`;

function installPlaywrightStub(dir: string): void {
  const stub = join(dir, "node_modules", "@playwright", "test");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "package.json"),
    JSON.stringify({
      name: "@playwright/test",
      version: "0.0.0-stub",
      type: "module",
      main: "index.js",
      exports: "./index.js",
    }) + "\n",
  );
  writeFileSync(join(stub, "index.js"), PLAYWRIGHT_STUB);
}

function writeRoleMatrix(dir: string): string {
  const path = join(dir, "role-matrix.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        configured: true,
        roles: MONKEY_ROLES.map((role) => ({
          id: role.id,
          allowRoutes: ["/"],
          denyRoutes: [`/forbidden-to-${role.id}`],
          requiredText: [`own-org-${role.id}`],
          forbiddenText: [`other-org-${role.id}`],
        })),
      },
      null,
      2,
    ) + "\n",
  );
  return path;
}

type Registration = { path: string[]; name: string };

function evaluateGeneratedSpec(
  dir = tempDir(),
  initialized = false,
): {
  status: number | null;
  stderr: string;
  registrations: Registration[];
} {
  const specPath = join(dir, "monkey.spec.mjs");
  const outPath = join(dir, "registrations.json");
  writeFileSync(
    specPath,
    ts.transpileModule(
      initialized
        ? readFileSync(join(dir, "tests/monkey/monkey.spec.ts"), "utf8")
        : monkeySpec("// generated\n"),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      },
    ).outputText,
  );
  installPlaywrightStub(dir);

  const run = spawnSync(process.execPath, [specPath], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 10_000,
    env: {
      ...process.env,
      MONKEY_ROLE_MATRIX: initialized
        ? join(dir, ".kit/monkey-test/role-matrix.json")
        : writeRoleMatrix(dir),
      MONKEY_STUB_OUT: outPath,
      MONKEY_EXPECTED_FINDINGS: "",
    },
  });

  assert.ifError(run.error);
  assert.equal(run.signal, null);
  const recorded = existsSync(outPath) ? readFileSync(outPath, "utf-8") : "[]";
  return {
    status: run.status,
    stderr: run.stderr ?? "",
    registrations: JSON.parse(recorded) as Registration[],
  };
}

function initHarness(dir: string, force = false) {
  const source = import.meta.url.endsWith(".ts");
  const command = new URL(
    source ? "./commands/monkey-test.ts" : "./commands/monkey-test.js",
    import.meta.url,
  ).href;
  const argv = ["node", "kit", "monkey-test", "init", "--json", ...(force ? ["--force"] : [])];
  const run = spawnSync(
    process.execPath,
    [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      `const { cmdMonkeyTest } = await import(${JSON.stringify(command)});
     process.argv = ${JSON.stringify(argv)};
     process.exitCode = await cmdMonkeyTest() ? 0 : 1;`,
    ],
    { cwd: dir, encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return run;
}

function loadGeneratedConfig(dir: string): { timeout: number; projects: { name: string }[] } {
  const configPath = join(dir, "playwright.monkey.config.mjs");
  writeFileSync(
    configPath,
    ts.transpileModule(readFileSync(join(dir, "playwright.monkey.config.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const { default: config } = await import("./playwright.monkey.config.mjs"); console.log(JSON.stringify(config));',
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, MONKEY_STUB_OUT: join(dir, "config-registrations.json") },
    },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

for (const force of [false, true]) {
  it(`preserves operator settings after init${force ? " --force" : ""}`, () => {
    const dir = tempDir();
    assert.equal(initHarness(dir).status, 0);
    installPlaywrightStub(dir);
    const configPath = join(dir, "playwright.monkey.config.ts");
    const config = readFileSync(configPath, "utf8").replace("timeout: 60_000", "timeout: 37_000");
    writeFileSync(configPath, config);
    const expectedPath = join(dir, ".kit/monkey-test/expected-findings.example.json");
    const expected = JSON.stringify([
      {
        title: "Operator exception",
        role: "staff",
        route: "/staff",
        reason: "Approved fixture exception for this test.",
      },
    ]);
    writeFileSync(expectedPath, expected);
    assert.equal(loadGeneratedConfig(dir).timeout, 37_000);

    const init = initHarness(dir, force);
    assert.equal(loadGeneratedConfig(dir).timeout, 37_000);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.equal(readFileSync(configPath, "utf8"), config);
    assert.equal(readFileSync(expectedPath, "utf8"), expected);
    assert.deepEqual(
      loadGeneratedConfig(dir).projects.map(({ name }) => name),
      ["desktop-chromium", "mobile-chrome"],
    );
  });

  it(`keeps configured roles usable after init${force ? " --force" : ""}`, () => {
    const dir = tempDir();
    assert.equal(initHarness(dir).status, 0);
    const matrixPath = writeRoleMatrix(join(dir, ".kit/monkey-test"));
    const matrix = readFileSync(matrixPath, "utf8");
    assert.equal(evaluateGeneratedSpec(dir, true).status, 0);
    if (force) {
      const specPath = join(dir, "tests/monkey/monkey.spec.ts");
      writeFileSync(
        specPath,
        readFileSync(specPath, "utf8") + '\nthrow new Error("stale scaffold");\n',
      );
    }

    const init = initHarness(dir, force);
    const loaded = evaluateGeneratedSpec(dir, true);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.equal(readFileSync(matrixPath, "utf8"), matrix);
    assert.deepEqual(
      loaded.registrations
        .filter(({ name }) => name === "route crawl")
        .map(({ path }) => path[0].split(":")[0]),
      ["public", "customer", "staff", "owner", "superadmin"],
    );
    assert.equal(loaded.registrations.filter(({ name }) => name === "money flow").length, 1);
  });
}

for (const matrix of ["", "{", '{"configured":true,"roles":[{"id":"staff"}]}']) {
  it(`preserves incomplete role configuration through forced init: ${JSON.stringify(matrix)}`, () => {
    const dir = tempDir();
    assert.equal(initHarness(dir).status, 0);
    const matrixPath = join(dir, ".kit/monkey-test/role-matrix.json");
    writeFileSync(matrixPath, matrix);
    assert.equal(evaluateGeneratedSpec(dir, true).status, 1);

    assert.equal(initHarness(dir, true).status, 0);
    assert.equal(readFileSync(matrixPath, "utf8"), matrix);
    assert.equal(evaluateGeneratedSpec(dir, true).status, 1);
  });
}

it("contains both viewports, every role, and real sandbox payment assertions", () => {
  const spec = monkeySpec("// generated\n");
  for (const role of ["public", "customer", "staff", "owner", "superadmin"]) {
    assert.match(spec, new RegExp(`\\{ id: "${role}"`));
  }
  assert.match(spec, /route crawl/);
  assert.match(spec, /validateMoneyFlowConfig/);
  assert.match(spec, /MONKEY_SANDBOX_INDICATOR/);
  assert.match(spec, /MONKEY_SKIP_MONEY_FLOW requires MONKEY_EXPECTED_REASON/);
  assert.match(spec, /Live payment env keys are not allowed/);
});

it("evaluates as a module and registers every role crawl plus the money flow", () => {
  const { status, stderr, registrations } = evaluateGeneratedSpec();

  // A contract helper the embed forgot resolves to nothing in the generated
  // file, so it fails only here, when the module is actually evaluated.
  assert.doesNotMatch(stderr, /ReferenceError/, `generated spec did not evaluate:\n${stderr}`);
  assert.equal(status, 0, `generated spec exited ${status}:\n${stderr}`);

  const crawls = registrations.filter((entry) => entry.name === "route crawl");
  assert.equal(crawls.length, MONKEY_ROLES.length);
  for (const role of MONKEY_ROLES) {
    assert.ok(
      crawls.some((entry) => entry.path.some((name) => name.startsWith(`${role.id}:`))),
      `no route crawl registered for ${role.id}`,
    );
  }

  const money = registrations.filter((entry) => entry.name === "money flow");
  assert.equal(money.length, 1);
  assert.deepEqual(money[0]?.path, ["customer payment"]);
  assert.equal(registrations.length, MONKEY_ROLES.length + 1);
});
