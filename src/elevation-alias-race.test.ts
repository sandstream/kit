import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";

const worker = `
  import fs from "node:fs/promises";
  import { appendFileSync, readFileSync } from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { join, resolve } from "node:path";
  const [moduleUrl, gate, projectA, projectB, alias] = process.argv.slice(1);
  const api = await import(moduleUrl);
  await api.grantElevation("purge-history", "yes-prompt", projectA);
  await api.grantElevation("vault-migrate", "yes-prompt", projectB);
  const markerA = join(projectA, ".kit", "elevation.json");
  const markerB = join(projectB, ".kit", "elevation.json");
  const savedA = readFileSync(markerA, "utf8");
  const savedB = readFileSync(markerB, "utf8");
  const read = fs.readFile;
  let held = false;
  fs.readFile = async (...args) => {
    const value = await read(...args);
    if (!held && typeof args[0] === "string" &&
        resolve(args[0]) === resolve(process.env.HOME, ".kit", "elevation.key")) {
      held = true;
      process.stdin.resume();
      const release = new Promise(resolve => process.stdin.once("data", resolve));
      process.stdout.write("KEY_READ\\n");
      await release;
      process.stdin.pause();
    }
    return value;
  };
  syncBuiltinESMExports();
  let stale;
  try {
    stale = await api[gate]("purge-history", alias);
    if (stale.ok) appendFileSync(join(alias, "effects.txt"), "purge-history\\n");
  } finally {
    fs.readFile = read;
    syncBuiltinESMExports();
  }
  const beforeRecovery = {
    effectsA: readFileSync(join(projectA, "effects.txt"), "utf8"),
    effectsB: readFileSync(join(projectB, "effects.txt"), "utf8"),
    markerAPreserved: readFileSync(markerA, "utf8") === savedA,
    markerBPreserved: readFileSync(markerB, "utf8") === savedB,
    activeA: await api.isElevated("purge-history", projectA),
    activeB: await api.isElevated("vault-migrate", projectB),
  };
  const recoveredA = await api.consumeElevation("purge-history", projectA);
  if (recoveredA.ok) appendFileSync(join(projectA, "effects.txt"), "purge-history\\n");
  const recoveredB = await api.consumeElevation("vault-migrate", alias);
  if (recoveredB.ok) appendFileSync(join(alias, "effects.txt"), "vault-migrate\\n");
  console.log("RESULT " + JSON.stringify({
    held, stale, beforeRecovery, recoveredA, recoveredB,
    finalEffectsA: readFileSync(join(projectA, "effects.txt"), "utf8"),
    finalEffectsB: readFileSync(join(projectB, "effects.txt"), "utf8"),
  }));
`;

function createAliasFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-elevation-alias-race-"));
  t.after(() => rmTemp(root));
  const home = join(root, "home");
  const projectA = join(root, "a");
  const projectB = join(root, "b");
  const alias = join(root, "alias");
  for (const path of [home, projectA, projectB]) mkdirSync(path);
  for (const project of [projectA, projectB]) writeFileSync(join(project, "effects.txt"), "");
  symlinkSync(projectA, alias, "junction");
  const env = { ...process.env };
  for (const name of [
    "KIT_ELEVATED",
    "KIT_READ_ONLY",
    "KIT_TOTP_SECRET",
    "KIT_ELEVATION_TTL_MINUTES",
  ])
    delete env[name];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_AUDIT_ANCHOR: "0",
    KIT_KEYSTORE: "file",
  });
  return { env, projectA, projectB, alias };
}

function startAliasWorker(fixture: ReturnType<typeof createAliasFixture>, gate: string) {
  const { env, projectA, projectB, alias } = fixture;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      worker,
      new URL("./elevation.js", import.meta.url).href,
      gate,
      projectA,
      projectB,
      alias,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  const output = { stdout: "", stderr: "" };
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  return { child, closed, output };
}

function waitForKeyRead({ child, output }: ReturnType<typeof startAliasWorker>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("signing-key read was not reached")), 15_000);
    child.stdout.on("data", (chunk) => {
      output.stdout += chunk;
      if (output.stdout.includes("KEY_READ\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(output.stderr || output.stdout));
    });
  });
}

for (const gate of ["consumeElevation", "requireElevation"]) {
  test(`${gate} refuses an alias retargeted during signature verification and preserves both grants`, async (t) => {
    const fixture = createAliasFixture(t);
    const { alias, projectB } = fixture;
    const workerProcess = startAliasWorker(fixture, gate);
    const { child, closed, output } = workerProcess;
    try {
      await waitForKeyRead(workerProcess);
      unlinkSync(alias);
      symlinkSync(projectB, alias, "junction");
      child.stdin.end("continue\n");
      const [code, signal] = await closed;
      assert.equal(code, 0, output.stderr);
      assert.equal(signal, null);
      const line = output.stdout.split("\n").find((value) => value.startsWith("RESULT "));
      assert.ok(line, output.stdout);
      const result = JSON.parse(line.slice(7));
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.held, true, "the alias must change during the signing-key read");
      assert.equal(result.beforeRecovery.effectsA, "");
      assert.equal(
        result.beforeRecovery.effectsB,
        "",
        "A's approval must not permit an effect in B",
      );
      assert.equal(result.stale.ok, false);
      assert.equal(result.beforeRecovery.markerAPreserved, true);
      assert.equal(result.beforeRecovery.markerBPreserved, true);
      assert.equal(result.beforeRecovery.activeA, true, "denial must not consume A's approval");
      assert.equal(result.beforeRecovery.activeB, true, "denial must not consume B's approval");
      assert.equal(result.recoveredA.ok, true);
      assert.equal(result.recoveredB.ok, true);
      assert.equal(result.finalEffectsA, "purge-history\n");
      assert.equal(result.finalEffectsB, "vault-migrate\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
}
