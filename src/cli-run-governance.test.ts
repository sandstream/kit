import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { projectConfig } from "./governance-outcome.test-support.js";

it("CLI run refuses a denied write before the child starts", async (t) => {
  const fixture = createCliContractFixture(
    `${projectConfig}\n[governance.access.dev]\nread = true\nwrite = false\ndelete = false\n`,
  );
  t.after(() => fixture.cleanup());
  const marker = join(fixture.cwd, "child-ran");
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ]);
  assert.equal(existsSync(marker), false, "denied command must never start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not allowed|denied/i);
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "run");
  assert.equal(events[0].success, false);
});

it("CLI run records actual success and failure and charges both attempts", async (t) => {
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  for (const code of [7, 0]) {
    const result = fixture.run([
      "run",
      "--",
      process.execPath,
      "-e",
      `console.log('ran-${code}'); process.exit(${code})`,
    ]);
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, new RegExp(`ran-${code}`));
  }
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.deepEqual(
    events.map((event) => [event.operation, event.success]),
    [
      ["run", false],
      ["run", true],
    ],
  );
  assert.match(events[0].error ?? "", /7/);
  const blocked = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "console.log('OVER_BUDGET_CHILD')",
  ]);
  assert.notEqual(blocked.status, 0);
  assert.doesNotMatch(blocked.stdout, /OVER_BUDGET_CHILD/);
  assert.match(blocked.stderr, /budget|operation.*limit/i);
});

it("CLI run applies the selected environment's permission overlay", (t) => {
  const fixture = createCliContractFixture(
    `${projectConfig}\n${projectConfig.replaceAll("[governance", "[env.staging.governance")}\n[env.staging.governance.access.dev]\nread = true\nwrite = false\ndelete = false\n`,
  );
  t.after(() => fixture.cleanup());
  const command = ["--", process.execPath, "-e", "console.log('SELECTED_CHILD')"];
  const allowed = fixture.run(["run", ...command]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /SELECTED_CHILD/);
  const denied = fixture.run(["run", "--env", "staging", ...command]);
  assert.notEqual(denied.status, 0);
  assert.doesNotMatch(denied.stdout, /SELECTED_CHILD/);
});

it("CLI run allows absent config but refuses an invalid existing config", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const path = join(fixture.cwd, ".kit.toml");
  const command = ["run", "--", process.execPath, "-e", "console.log('CONFIG_CHILD')"];
  rmSync(path);
  const absent = fixture.run(command);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /CONFIG_CHILD/);
  writeFileSync(path, "[broken TOML");
  const invalid = fixture.run(command);
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stdout, /CONFIG_CHILD/);
  assert.match(invalid.stderr, /Could not read or validate project configuration/);
});

for (const governed of [false, true]) {
  it(`CLI run obeys an active resource policy before starting a child (governance=${governed})`, (t) => {
    const fixture = createCliContractFixture(governed ? projectConfig : "version = 1\n");
    t.after(() => fixture.cleanup());
    writeFileSync(
      join(fixture.cwd, ".kit-exec-broker.json"),
      JSON.stringify({ egress: { allow: [] }, fs: { root: fixture.cwd }, env: { declared: [] } }),
    );
    const marker = join(fixture.cwd, "child-ran");
    const result = fixture.run([
      "run",
      "--",
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
      "https://outside.invalid",
    ]);
    assert.equal(existsSync(marker), false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exec-broker.*denied/i);
  });
}

it("CLI run preserves a failed child result through both audit layers", async (t) => {
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  writeFileSync(
    join(fixture.cwd, ".kit-exec-broker.json"),
    JSON.stringify({ egress: { allow: [] }, fs: { root: fixture.cwd }, env: { declared: [] } }),
  );
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "console.log('FAILED_CHILD'); process.exit(7)",
  ]);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /FAILED_CHILD/);
  const events = (await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"))).filter(
    (event) => event.metadata?.phase !== "authorized",
  );
  assert.equal(events.length, 2);
  assert.ok(
    events.every((event) => !event.success && /7/.test(event.error ?? "")),
    JSON.stringify(events),
  );
});
