import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingAction } from "../memory/pal.js";
import { fixture, storedAction } from "../memory/pal-cli.test-support.js";
import { seedLegacyPalDb } from "../memory/pal-fixture.test-support.js";

it("PAL CLI repairs, disables and re-enables a verifier without rewriting creation history", async (t) => {
  const { cli, invoke, dbPath, root } = await fixture(t);
  seedLegacyPalDb(dbPath, [
    {
      id: "legacy",
      title: "legacy check",
      kind: "auto",
      verify_check: JSON.stringify({ type: "file-exists", path: "artifact" }),
      origin_root: null,
    },
  ]);
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  await assert.rejects(cli("verify", "--json"), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 1);
    const report = JSON.parse(failure.stdout ?? "");
    assert.equal(report.checked, 0);
    assert.deepEqual(report.closed, []);
    assert.deepEqual(
      report.unverified.map(({ id, reason }: { id: string; reason: string }) => ({ id, reason })),
      [{ id: action.id, reason: "unbound-path" }],
    );
    return true;
  });
  const before = storedAction(dbPath, action.id)!;
  const other = join(root, "replacement-project");
  mkdirSync(other);
  writeFileSync(join(other, "artifact"), "explicit replacement target");
  const configured = JSON.parse(
    await invoke(["configure", action.id, "--verify-file", "artifact", "--json"], [], other),
  );
  assert.deepEqual(configured, { id: action.id, kind: "auto" });
  const grant = storedAction(dbPath, action.id)?.verify_grant;
  assert.match(String(grant), /^[a-f0-9]{32}$/);
  assert.notEqual(grant, before.verify_grant);
  assert.deepEqual(
    { ...storedAction(dbPath, action.id) },
    {
      ...before,
      verify_grant: grant,
      verify_definition: JSON.stringify({ type: "file-exists", path: join(other, "artifact") }),
    },
  );
  await cli("verify");
  assert.deepEqual(JSON.parse(await cli("verify", "--json")).closed, [action.id]);
  const closed = storedAction(dbPath, action.id)!;
  assert.deepEqual(JSON.parse(await cli("configure", action.id, "--manual", "--json")), {
    id: action.id,
    kind: "manual",
  });
  assert.deepEqual(
    { ...storedAction(dbPath, action.id) },
    {
      ...closed,
      kind: "manual",
      verify_definition: null,
      verify_grant: null,
      verify_passes: 0,
    },
  );
  rmSync(join(other, "artifact"));
  assert.equal(JSON.parse(await cli("verify", "--json")).checked, 0);
  assert.equal(storedAction(dbPath, action.id)?.status, "closed");
  await invoke(["configure", action.id, "--verify-file", "artifact"], [], other);
  assert.deepEqual(JSON.parse(await cli("verify", "--json")).reopened, [action.id]);
});

it("PAL verifier configuration rejects ambiguous input and respects read-only mode", async (t) => {
  const { cli, dbPath } = await fixture(t);
  await cli("add", "configuration validation");
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  const before = storedAction(dbPath, action.id);
  for (const flags of [
    [],
    ["--manual", "--verify-file", "artifact"],
    ["--verify-file", "artifact", "--verify-http", "https://example.com"],
    ["--verify-file", "one", "--verify-file", "two"],
    ["--verify-file", ""],
    ["--verify-file"],
    ["--manual", "extra"],
    ["--manual", "--expect", "200"],
    ["--verify-http", "file:///tmp/artifact"],
    ["--verify-http", "https://example.com", "--expect", "NaN"],
    ["--verify-http", "https://example.com", "--expect", "200.5"],
    ["--verify-http", "https://example.com", "--expect", "600"],
  ]) {
    await assert.rejects(cli("configure", action.id, ...flags), { code: 2 });
    assert.deepEqual(storedAction(dbPath, action.id), before);
  }
  await assert.rejects(
    cli("configure", action.id, "--manual", "--read-only"),
    /read-only mode active/,
  );
  assert.deepEqual(storedAction(dbPath, action.id), before);
  await assert.rejects(cli("configure", "missing", "--manual"), { code: 1 });
  await assert.rejects(cli("configure", "missing", "--manual", "--json"), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 1);
    assert.deepEqual(JSON.parse(failure.stdout ?? ""), { id: "missing", error: "not-found" });
    return true;
  });
});
