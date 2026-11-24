import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

it("reports empty memory and pending actions through the public JSON commands", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);

  const stats = fixture.run(["memory", "stats", "--json"]);
  assert.equal(stats.status, 0, stats.stderr);
  const { sessions, messages, toolUses, pendingOpen } = JSON.parse(stats.stdout);
  assert.deepEqual(
    { sessions, messages, toolUses, pendingOpen },
    {
      sessions: 0,
      messages: 0,
      toolUses: 0,
      pendingOpen: 0,
    },
  );

  const actions = fixture.run(["memory", "pal", "list", "--json"]);
  assert.equal(actions.status, 0, actions.stderr);
  assert.deepEqual(JSON.parse(actions.stdout), []);
});

it("distinguishes absent optional deployment configuration from an absent project", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  const args = ["check", "--category", "deploy", "--json"];

  const optional = fixture.run(args);
  assert.equal(optional.status, 0, optional.stderr);
  const { ok, scope, checks, summary } = JSON.parse(optional.stdout);
  assert.equal(ok, true);
  assert.deepEqual(scope, ["deploy"]);
  assert.deepEqual(
    checks.map(({ name, status }: { name: string; status: string }) => ({ name, status })),
    [{ name: "deploy", status: "skip" }],
  );
  assert.deepEqual(summary, { passed: 0, failed: 0, warnings: 0, skipped: 1 });

  unlinkSync(join(fixture.cwd, ".kit.toml"));
  const missing = fixture.run(args);
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: ".kit.toml not found" });
});

it("does not pass ignore protection when it cannot inspect Git", (t) => {
  const fixture = createCliContractFixture();
  t.after(fixture.cleanup);
  Object.assign(fixture.env, {
    KIT_AIRGAP: "1",
    KIT_ADVISORIES: "0",
    KIT_BUMBLEBEE: "0",
    KIT_EXPLOIT_INTEL: "0",
    KIT_NO_DOWNLOAD: "1",
  });

  const check = fixture.run(["check", "--category", "security", "--json"]);
  assert.equal(check.status, 1, check.stderr);
  const { ok, checks } = JSON.parse(check.stdout);
  assert.equal(ok, false);
  const ignore = checks.find(({ name }: { name: string }) => name === ".env gitignored");
  assert.ok(ignore);
  assert.equal(ignore.status, "warn");
  assert.equal(ignore.didNotRun, true);
});
