import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { consumeElevation, grantElevation, writeElevation } from "./elevation.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function createExpiryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-elevation-expiry-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const originalCwd = process.cwd();
  const names = [
    "HOME",
    "USERPROFILE",
    "KIT_IDENTITY_DIR",
    "KIT_MEMORY_DB",
    "KIT_MEMORY_DIR",
    "KIT_AUDIT_ANCHOR_DIR",
    "KIT_AUDIT_ANCHOR",
    "KIT_ELEVATED",
    "KIT_READ_ONLY",
    "KIT_ELEVATION_TTL_MINUTES",
    "KIT_KEYSTORE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_AUDIT_ANCHOR: "0",
    KIT_KEYSTORE: "file",
  });
  process.chdir(project);
  t.after(() => {
    process.chdir(originalCwd);
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmTemp(root);
  });

  const effect = join(project, "effect.txt");
  writeFileSync(effect, "");
  return { home, project, effect };
}

function startAuthorityLocker(home: string, expires: number) {
  // The second process holds a real SQLite write lock across the signed expiry.
  // Its timer runs independently while the consumer waits synchronously for that lock.
  const locker = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("LOCKED\\n");
    setTimeout(() => {
      db.exec("ROLLBACK");
      db.close();
    }, Math.max(0, Number(process.argv[2]) - Date.now()) + 250);
  `,
      join(home, ".kit", "elevation-authority", "grants.sqlite"),
      String(expires),
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(locker, "close");
  const output = { stderr: "" };
  locker.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  return { locker, closed, output };
}

function waitForAuthorityLock({
  locker,
  output,
}: ReturnType<typeof startAuthorityLocker>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("authority lock was not acquired")), 2_000);
    let stdout = "";
    locker.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("LOCKED\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    locker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    locker.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(output.stderr));
    });
  });
}

test("one-shot approval that expires while another process holds authority cannot authorize an effect", async (t) => {
  const { home, project, effect } = createExpiryFixture(t);
  // Create the signing key and authority before the short expiry starts.
  // Initial Windows ACL setup must not use the contention test's time window.
  await grantElevation("purge-history", "yes-prompt", project);
  const expires = Date.now() + 3_000;
  await writeElevation(
    {
      scope: "purge-history",
      method: "yes-prompt",
      granter: "expiry-test",
      expiresAt: new Date(expires).toISOString(),
    },
    project,
  );
  const authorityProcess = startAuthorityLocker(home, expires);
  const { locker, closed, output } = authorityProcess;
  try {
    await waitForAuthorityLock(authorityProcess);
    assert.ok(Date.now() < expires, "approval must still be valid when consumption begins");
    const result = await consumeElevation("purge-history", project);
    if (result.ok) appendFileSync(effect, "effect\n");
    const observedAt = Date.now();
    const [code, signal] = await closed;
    assert.equal(code, 0, output.stderr);
    assert.equal(signal, null);
    assert.ok(observedAt > expires, "authority must remain locked until approval expires");
    t.diagnostic(
      JSON.stringify({ expires, observedAt, result, effects: readFileSync(effect, "utf8") }),
    );
    assert.equal(readFileSync(effect, "utf8"), "", "expired approval must not permit an effect");
    assert.equal(result.ok, false, "expiry must be checked after authority lock acquisition");

    await grantElevation("purge-history", "yes-prompt", project);
    const fresh = await consumeElevation("purge-history", project);
    if (fresh.ok) appendFileSync(effect, "effect\n");
    assert.equal(fresh.ok, true, "fresh approval must recover in the same process");
    assert.equal(readFileSync(effect, "utf8"), "effect\n");
  } finally {
    if (locker.exitCode === null && locker.signalCode === null) locker.kill();
    await closed;
  }
});
