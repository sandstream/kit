import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";

// Exercise public grant and inspection calls with the Windows ACL contract.
// This models scripts/windows-private-acl.ps1, not native Windows execution.
// A new directory inherits permissions. Verification requires a protected ACL
// with one explicit owner entry, so inherited permissions cannot pass it.
const worker = `
  import assert from "node:assert/strict";
  import cp from "node:child_process";
  import { existsSync, mkdirSync, readFileSync } from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { basename, join } from "node:path";
  const [url, readonlyUrl, scenario, home, project] = process.argv.slice(1);
  const api = await import(url);
  await import(readonlyUrl);
  const directory = join(home, ".kit", "elevation-authority");
  const database = join(directory, "grants.sqlite");
  const marker = join(project, ".kit", "elevation.json");
  const protectedPaths = new Set();
  const calls = [];
  if (scenario !== "fresh") mkdirSync(directory, { recursive: true });
  if (scenario === "inspection") protectedPaths.add(directory);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const exec = cp.execFileSync;
  try {
    cp.execFileSync = (program, args, options) => {
      assert.equal(basename(program), "powershell.exe");
      const path = options.env.KIT_PRIVATE_ACL_PATH;
      const repair = options.env.KIT_PRIVATE_ACL_REPAIR === "1";
      calls.push({ path, repair });
      if (repair) protectedPaths.add(path);
      if (protectedPaths.has(path)) return "PRIVATE\\n";
      throw Object.assign(new Error("Inherited ACL is not private"), { status: 3 });
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    if (scenario === "fresh") {
      await api.grantElevation("purge-history", "yes-prompt", project);
      const repairsBeforeRead = calls.filter(call => call.repair).length;
      assert.equal(await api.isElevated("purge-history", project), true);
      assert.equal(calls.filter(call => call.repair).length, repairsBeforeRead);
    } else if (scenario === "unsafe-existing") {
      await assert.rejects(
        api.grantElevation("purge-history", "yes-prompt", project),
        /Elevation authority is unavailable/,
      );
      assert.equal(calls.some(call => call.path === directory && call.repair), false);
      assert.equal(existsSync(database), false);
      assert.equal(existsSync(marker), false);
    } else {
      await api.grantElevation("purge-history", "yes-prompt", project);
      assert.equal(await api.isElevated("purge-history", project), true);
      const markerBefore = readFileSync(marker);
      const databaseBefore = readFileSync(database);
      protectedPaths.delete(directory);
      const repairsBeforeRead = calls.filter(call => call.repair).length;
      assert.equal(await api.isElevated("purge-history", project), false);
      assert.equal(calls.filter(call => call.repair).length, repairsBeforeRead);
      assert.deepEqual(readFileSync(marker), markerBefore);
      assert.deepEqual(readFileSync(database), databaseBefore);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    cp.execFileSync = exec;
    syncBuiltinESMExports();
  }
`;

function runScenario(t: TestContext, scenario: "fresh" | "unsafe-existing" | "inspection") {
  const root = mkdtempSync(join(tmpdir(), "kit-authority-acl-"));
  t.after(() => rmTemp(root));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const env = { ...process.env };
  for (const key of [
    "KIT_ELEVATED",
    "KIT_READ_ONLY",
    "KIT_TOTP_SECRET",
    "KIT_ELEVATION_TTL_MINUTES",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_AUDIT_ANCHOR: "0",
    SystemRoot: join(root, "Windows"),
  });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      worker,
      new URL("./elevation.js", import.meta.url).href,
      new URL("./read-only-mode.js", import.meta.url).href,
      scenario,
      home,
      project,
    ],
    { env, encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
}

test("Windows ACL contract simulation: fresh approval establishes private authority before inspection", (t) => {
  runScenario(t, "fresh");
});

test("Windows ACL contract simulation: approval refuses an unsafe existing authority directory without repair", (t) => {
  runScenario(t, "unsafe-existing");
});

test("Windows ACL contract simulation: inspection refuses changed permissions without repair or storage writes", (t) => {
  runScenario(t, "inspection");
});
