import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { auditFixture } from "./audit-concurrency.test-support.js";
import { npmScopeGap, readNpmAuditScope } from "./npm-audit-scope.js";

function put(root: string, file: string, value: unknown): void {
  writeFileSync(join(root, file), JSON.stringify(value));
}

const modern = {
  lockfileVersion: 3,
  packages: { "": {}, "node_modules/example": { version: "1.0.0" } },
};

it("uses npm-shrinkwrap first and requires the same reported inventory", (t) => {
  const { project } = auditFixture(t);
  put(project, "package-lock.json", { lockfileVersion: 3, packages: { "": {} } });
  put(project, "npm-shrinkwrap.json", modern);
  const scope = readNpmAuditScope(project);
  assert.ok(!("status" in scope));
  assert.equal(scope.file, "npm-shrinkwrap.json");
  assert.equal(scope.inventory, 1);
  assert.equal(npmScopeGap(project, scope, 1), undefined);
  assert.match(npmScopeGap(project, scope, 0)?.reason ?? "", /inventory does not match/);
  put(project, "npm-shrinkwrap.json", { ...modern, name: "changed" });
  assert.match(npmScopeGap(project, scope, 1)?.reason ?? "", /changed during/);
});

it("counts legacy nested packages and rejects unsupported or incomplete lockfile data", (t) => {
  const { project } = auditFixture(t);
  const file = "package-lock.json";
  put(project, file, { lockfileVersion: 1, dependencies: { a: { dependencies: { b: {} } } } });
  const scope = readNpmAuditScope(project);
  assert.ok(!("status" in scope));
  assert.equal(scope.inventory, 2);
  put(project, file, { lockfileVersion: 9, packages: {} });
  assert.equal((readNpmAuditScope(project) as { status?: string }).status, "unsupported");
  put(project, file, { lockfileVersion: 3, packages: {} });
  assert.equal((readNpmAuditScope(project) as { status?: string }).status, "malformed");
});
