import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { migrateConfigFile } from "./config.js";

const LEGACY_TOML = `[tools]
node = "22"
pnpm = "latest"

[services.github]
login = "gh auth login"
check = "gh auth status"
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("migrateConfigFile", () => {
  let dir: string;
  let cfgPath: string;
  let backupPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-config-migrate-"));
    cfgPath = join(dir, ".kit.toml");
    backupPath = `${cfgPath}.backup`;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("migrates a legacy config: stamps version=1, backs up original, re-validates", async () => {
    await writeFile(cfgPath, LEGACY_TOML, "utf-8");

    const outcome = await migrateConfigFile(cfgPath);
    assert.equal(outcome.status, "migrated");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.fromVersion, 0);
    assert.equal(outcome.toVersion, 1);
    assert.equal(outcome.wrote, true);

    // Migrated file now declares version = 1 and keeps existing data.
    const written = parse(await readFile(cfgPath, "utf-8")) as Record<string, unknown>;
    assert.equal(written.version, 1);
    assert.deepEqual(written.tools, { node: "22", pnpm: "latest" });

    // Original backed up verbatim.
    assert.ok(await exists(backupPath));
    assert.equal(await readFile(backupPath, "utf-8"), LEGACY_TOML);
  });

  it("--dry-run writes nothing", async () => {
    await writeFile(cfgPath, LEGACY_TOML, "utf-8");

    const outcome = await migrateConfigFile(cfgPath, { dryRun: true });
    assert.equal(outcome.status, "dry-run");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.wrote, false);

    // File unchanged, no backup created.
    assert.equal(await readFile(cfgPath, "utf-8"), LEGACY_TOML);
    assert.equal(await exists(backupPath), false);
  });

  it("refuses to clobber an existing backup without --force", async () => {
    await writeFile(cfgPath, LEGACY_TOML, "utf-8");
    await writeFile(backupPath, "PRE-EXISTING BACKUP", "utf-8");

    const outcome = await migrateConfigFile(cfgPath);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.wrote, false);
    assert.match(outcome.message, /already exists/);

    // Backup untouched, config unchanged.
    assert.equal(await readFile(backupPath, "utf-8"), "PRE-EXISTING BACKUP");
    assert.equal(await readFile(cfgPath, "utf-8"), LEGACY_TOML);
  });

  it("overwrites the backup with --force", async () => {
    await writeFile(cfgPath, LEGACY_TOML, "utf-8");
    await writeFile(backupPath, "PRE-EXISTING BACKUP", "utf-8");

    const outcome = await migrateConfigFile(cfgPath, { force: true });
    assert.equal(outcome.status, "migrated");
    assert.equal(outcome.ok, true);
    assert.equal(await readFile(backupPath, "utf-8"), LEGACY_TOML);
  });

  it("reports 'already current' and exits ok for a v1 config", async () => {
    await writeFile(cfgPath, `version = 1\n${LEGACY_TOML}`, "utf-8");

    const outcome = await migrateConfigFile(cfgPath);
    assert.equal(outcome.status, "already-current");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.wrote, false);
    assert.equal(await exists(backupPath), false);
  });

  it("--check exits non-zero on a legacy config without writing", async () => {
    await writeFile(cfgPath, LEGACY_TOML, "utf-8");

    const outcome = await migrateConfigFile(cfgPath, { check: true });
    assert.equal(outcome.status, "stale");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.wrote, false);
    assert.equal(await readFile(cfgPath, "utf-8"), LEGACY_TOML);
    assert.equal(await exists(backupPath), false);
  });

  it("--check passes for a current config", async () => {
    await writeFile(cfgPath, `version = 1\n${LEGACY_TOML}`, "utf-8");

    const outcome = await migrateConfigFile(cfgPath, { check: true });
    assert.equal(outcome.status, "already-current");
    assert.equal(outcome.ok, true);
  });

  it("errors (no write) when the config is newer than this kit", async () => {
    await writeFile(cfgPath, `version = 99\n${LEGACY_TOML}`, "utf-8");

    const outcome = await migrateConfigFile(cfgPath);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /newer than this kit/);
    assert.equal(await exists(backupPath), false);
  });
});
