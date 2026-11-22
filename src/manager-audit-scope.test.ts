import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { managerScopeChanged, readManagerAuditScope } from "./manager-audit-scope.js";
import { managerFixture, yarnLock } from "./manager-audit-scope.test-support.js";

it("detects changes to the audited lockfile and initially absent settings", (t) => {
  const { project, lockfile, env } = managerFixture(t, "yarn");
  const result = readManagerAuditScope(project, "yarn", env);
  assert.ok(!("status" in result));
  assert.equal(managerScopeChanged(result), false);
  writeFileSync(lockfile, yarnLock + "\n");
  assert.equal(managerScopeChanged(result), true);
  writeFileSync(lockfile, yarnLock);
  writeFileSync(join(project, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  assert.equal(managerScopeChanged(result), true);
});

it("refuses configuration that can load plugins or hide an advisory", (t) => {
  const { project, home, env } = managerFixture(t, "yarn");
  for (const root of [project, home]) {
    writeFileSync(join(root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  }
  assert.ok(!("status" in readManagerAuditScope(project, "yarn", env)));
  writeFileSync(join(home, ".yarnrc.yml"), "npmAuditExcludePackages: [fixture]\n");
  const result = readManagerAuditScope(project, "yarn", env);
  assert.ok("status" in result);
  assert.equal(result.status, "unsupported");
});

it("marks non-npm Yarn package protocols as outside the report coverage", (t) => {
  const { project, lockfile, env } = managerFixture(t, "yarn");
  writeFileSync(
    lockfile,
    yarnLock + '\n"external@file:other":\n  resolution: "external@file:other"\n',
  );
  const result = readManagerAuditScope(project, "yarn", env);
  assert.ok(!("status" in result));
  assert.equal(result.gap?.status, "partial");
});

it("does not trust a binary Bun lockfile when text also exists", (t) => {
  const { project, env } = managerFixture(t, "bun");
  writeFileSync(join(project, "bun.lockb"), Buffer.from([0, 1]));
  const result = readManagerAuditScope(project, "bun", env);
  assert.ok("status" in result);
  assert.equal(result.status, "unsupported");
});
