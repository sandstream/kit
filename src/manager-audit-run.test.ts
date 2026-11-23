import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { detectAuditRunner, runAudit } from "./advisory-baseline.js";
import { managerAuditRunner } from "./manager-audit-run.js";
import { managerFixture } from "./manager-audit-scope.test-support.js";

const output = (stdout: string): string[] => [
  process.execPath,
  "-e",
  `process.stdout.write(${JSON.stringify(stdout)})`,
];

it("selects the Yarn recursive audit and its separate proof and version commands", async (t) => {
  const { project } = managerFixture(t, "yarn");
  const runner = await detectAuditRunner(project);
  assert.ok(runner);
  assert.equal(runner.manager, "yarn");
  assert.ok(runner.command.includes("--all"));
  assert.ok(runner.command.includes("--recursive"));
  assert.ok(runner.command.includes("--no-deprecations"));
  assert.ok(runner.command.includes("--json"));
  assert.deepEqual(runner.proofCommand, runner.command.slice(0, -1));
  assert.deepEqual(runner.versionCommand, ["yarn", "--version"]);
  const pnpm = managerAuditRunner("pnpm");
  assert.ok(pnpm.command.includes("--audit-level=info"));
  assert.ok(pnpm.command.includes("--ignore-registry-errors=false"));
});

it("accepts Yarn's silent JSON only with explicit successful clean confirmation", (t) => {
  const fixture = managerFixture(t, "yarn");
  const yarn = { manager: "yarn", command: output(""), versionCommand: output("4.17.0\n") };
  const unconfirmed = runAudit(fixture.project, yarn, 5000, fixture.env);
  assert.equal(unconfirmed.evidenceStatus, "missing");
  assert.ok(unconfirmed.error);
  const runner = { ...yarn, proofCommand: output("➤ YN0001: No audit suggestions\n") };
  const confirmed = runAudit(fixture.project, runner, 5000, fixture.env);
  assert.deepEqual(confirmed, {
    manager: "yarn",
    advisories: [],
    evidenceStatus: "complete-empty",
  });
  const legacy = runAudit(
    fixture.project,
    { ...runner, versionCommand: output("1.22.22") },
    5000,
    fixture.env,
  );
  assert.equal(legacy.evidenceStatus, "unsupported");
});

it("preserves the acquisition error even if Bun supplied a shape that could be clean", (t) => {
  const { project, env } = managerFixture(t, "bun");
  const broken = [process.execPath, "-e", 'process.stdout.write("{}"); process.exitCode=2'];
  const result = runAudit(project, { manager: "bun", command: broken }, 5000, env);
  assert.equal(result.evidenceStatus, "unavailable");
  assert.ok(result.error);
});

it("audits the verified Bun lock copy without the project's environment file", (t) => {
  const { project, home, lockfile, env } = managerFixture(t, "bun");
  const cwdReceipt = join(home, "cwd.txt");
  writeFileSync(join(project, ".env"), "BUN_CONFIG_REGISTRY=http://127.0.0.1:1/\n");
  const source = `
    const fs = require("node:fs");
    if (fs.existsSync(".env") || fs.readFileSync("bun.lock","utf8") !== ${JSON.stringify(readFileSync(lockfile, "utf8"))}) process.exit(2);
    fs.writeFileSync(${JSON.stringify(cwdReceipt)}, process.cwd());
    process.stdout.write("{}");
  `;
  const result = runAudit(
    project,
    { manager: "bun", command: [process.execPath, "-e", source] },
    5000,
    env,
  );
  assert.equal(result.evidenceStatus, "complete-empty");
  assert.notEqual(readFileSync(cwdReceipt, "utf8"), project);
  assert.equal(existsSync(readFileSync(cwdReceipt, "utf8")), false);
});

it("refuses a successful report if the manager's selected lockfile changed", (t) => {
  const { project, lockfile, env } = managerFixture(t, "pnpm");
  const report = {
    advisories: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies: 0,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 0,
    },
  };
  const code = `require("node:fs").appendFileSync(${JSON.stringify(lockfile)}, "\\n"); process.stdout.write(${JSON.stringify(JSON.stringify(report))});`;
  const result = runAudit(
    project,
    { manager: "pnpm", command: [process.execPath, "-e", code] },
    5000,
    env,
  );
  assert.equal(result.evidenceStatus, "stale");
  assert.match(result.error ?? "", /inputs changed/);
});
