import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

function snapshot(root: string): unknown[] {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name);
      const stat = statSync(path);
      return stat.isDirectory()
        ? [name, snapshot(path)]
        : [
            name,
            createHash("sha256").update(readFileSync(path)).digest("hex"),
            stat.ino,
            stat.mtimeMs,
            stat.mode,
          ];
    });
}

for (const source of ["flag", "policy", "env"]) {
  for (const existing of [false, true]) {
    test(`${source} activation preserves ${existing ? "existing" : "absent"} audit and anchor files`, async (t) => {
      const fixture = auditFixture(t, true);
      if (existing) {
        await runAuditWorkers([
          startAuditWorker(
            fixture,
            `
            assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
          `,
          ),
        ]);
      }
      const before = snapshot(fixture.root);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "--eval",
          `
          import { activateReadOnlyMode, isReadOnlyMode } from ${JSON.stringify(new URL("./read-only-mode.js", import.meta.url).href)};
          activateReadOnlyMode(${JSON.stringify(source)});
          activateReadOnlyMode(${JSON.stringify(source)});
          console.log(JSON.stringify({ active: isReadOnlyMode(), childFlag: process.env.KIT_READ_ONLY }));
        `,
        ],
        { cwd: fixture.project, env: fixture.env, encoding: "utf8", timeout: 10_000 },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { active: true, childFlag: "1" });
      assert.match(result.stderr, /read-only mode active/);
      assert.deepEqual(snapshot(fixture.root), before);
    });
  }
}

for (const source of ["flag", "policy", "env"]) {
  test(`read-only JSON verification via ${source} preserves the sealed log and home`, async (t) => {
    const fixture = auditFixture(t, true);
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
        assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
      `,
      ),
    ]);
    if (source === "policy")
      writeFileSync(
        join(fixture.project, ".kit.toml"),
        'version = 1\n[policy]\ndefault_mode = "read-only"\n',
      );
    if (source === "env") fixture.env.KIT_READ_ONLY = "true";
    const before = snapshot(fixture.root);

    const result = auditCli(fixture, [
      "verify",
      "--strict",
      "--json",
      ...(source === "flag" ? ["--read-only"] : []),
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.deepEqual(snapshot(fixture.root), before);
  });
}

test("read-only mode still refuses an explicit anchor write and records the refusal", (t) => {
  const fixture = auditFixture(t);
  const result = auditCli(fixture, ["anchor", "--read-only"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /refusing/);
  const entries = readFileSync(join(fixture.project, ".kit-audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, "read-only-mode-refusal");
  assert.equal(entries[0].success, false);
  assert.deepEqual(readdirSync(fixture.home), []);
});
