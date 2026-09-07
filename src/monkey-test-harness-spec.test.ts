import { describe, it, afterEach } from "node:test";
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

function evaluateGeneratedSpec(): {
  status: number | null;
  stderr: string;
  registrations: Registration[];
} {
  const dir = tempDir();
  const specPath = join(dir, "monkey.spec.mjs");
  const outPath = join(dir, "registrations.json");
  writeFileSync(
    specPath,
    ts.transpileModule(monkeySpec("// generated\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  installPlaywrightStub(dir);

  const run = spawnSync(process.execPath, [specPath], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      MONKEY_ROLE_MATRIX: writeRoleMatrix(dir),
      MONKEY_STUB_OUT: outPath,
      MONKEY_EXPECTED_FINDINGS: "",
    },
  });

  const recorded = existsSync(outPath) ? readFileSync(outPath, "utf-8") : "[]";
  return {
    status: run.status,
    stderr: run.stderr ?? "",
    registrations: JSON.parse(recorded) as Registration[],
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("generated monkey Playwright spec", () => {
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
});
