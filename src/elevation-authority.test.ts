import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";

const worker = `
  import { appendFileSync } from "node:fs";
  const api = await import(process.argv[1]);
  const [action, project, effect, scope = "purge-history"] = process.argv.slice(2);
  const barrier = async () => {
    process.stdin.resume();
    process.stdout.write("READY\\n");
    await new Promise(resolve => process.stdin.once("data", resolve));
    process.stdin.pause();
  };
  if (action === "held-consume") {
    const fs = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const { join } = await import("node:path");
    const read = fs.readFile;
    let held = false;
    fs.readFile = async (...args) => {
      const value = await read(...args);
      if (!held && args[0] === join(project, ".kit", "elevation.json")) {
        held = true;
        await barrier();
      }
      return value;
    };
    syncBuiltinESMExports();
  }
  const use = async () => {
    const value = await api.consumeElevation(scope, project);
    if (value.ok) appendFileSync(effect, "effect\\n");
    return value;
  };
  let result;
  if (action === "grant") {
    await api.grantElevation(scope, "yes-prompt", project);
    result = { ok: true };
  } else if (action === "revoke") {
    await api.clearElevation(project);
    result = { ok: true };
  } else if (action === "inspect") {
    result = { ok: await api.isElevated(scope, project) };
  } else if (action === "ci-race") {
    process.env.KIT_ELEVATED = "1";
    result = { results: await Promise.all(Array.from({ length: 8 }, use)) };
  } else if (action === "fresh-reuse") {
    const first = await use();
    await api.grantElevation(scope, "yes-prompt", project);
    result = { results: [first, await use()] };
  } else {
    if (action === "race") {
      await barrier();
    }
    result = await use();
  }
  console.log("RESULT " + JSON.stringify(result));
`;

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
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
    KIT_IDENTITY_DIR: join(home, "identity"),
    KIT_MEMORY_DB: join(home, "memory.db"),
    KIT_MEMORY_DIR: join(home, "memory"),
    KIT_AUDIT_ANCHOR_DIR: join(home, "anchors"),
    KIT_AUDIT_ANCHOR: "0",
  });
  return env;
}

/** Start one worker. It prints READY at the start barrier and continues when stdin closes. */
function startWorker(t: TestContext, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("worker did not reach the start barrier")),
      10_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { child, closed, ready, output: () => ({ stdout, stderr }) };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-one-shot-"));
  t.after(() => rmTemp(root));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  const env = isolatedEnvironment(home);
  const effect = join(root, "effects.txt");
  writeFileSync(effect, "");
  const args = (action: string, scope: string) => [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    worker,
    new URL("./elevation.js", import.meta.url).href,
    action,
    project,
    effect,
    scope,
  ];
  const parse = (stdout: string) => {
    const line = stdout.split("\n").find((value) => value.startsWith("RESULT "));
    assert.ok(line, stdout);
    return JSON.parse(line.slice(7)) as {
      ok: boolean;
      reason?: string;
      results?: { ok: boolean }[];
    };
  };
  const run = (action: string, scope = "purge-history") => {
    const child = spawnSync(process.execPath, args(action, scope), {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr);
    return parse(child.stdout);
  };
  const race = async (scopes: string[], action = "race", afterReady?: () => void) => {
    const children = scopes.map((scope) => startWorker(t, args(action, scope), env));
    try {
      await Promise.all(children.map((child) => child.ready));
      afterReady?.();
      for (const { child } of children) child.stdin.end("go\n");
      return await Promise.all(
        children.map(async ({ closed, output }) => {
          const [code, signal] = await closed;
          assert.equal(code, 0, output().stderr);
          assert.equal(signal, null);
          return parse(output().stdout);
        }),
      );
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.all(children.map((child) => child.closed));
    }
  };
  return { project, home, effect, run, race };
}

test("a restored one-shot marker cannot authorize a second process, but fresh approval can", (t) => {
  const { project, effect, run } = fixture(t);
  run("grant");
  const marker = join(project, ".kit", "elevation.json");
  const saved = readFileSync(marker);
  assert.equal(run("consume").ok, true);
  assert.equal(readFileSync(effect, "utf8"), "effect\n");
  writeFileSync(marker, saved);
  assert.equal(run("consume").ok, false, "saved approval must not authorize another effect");
  assert.equal(readFileSync(effect, "utf8"), "effect\n");
  assert.equal(run("inspect").ok, false);
  run("grant");
  assert.equal(run("consume").ok, true);
  assert.equal(readFileSync(effect, "utf8"), "effect\neffect\n");
});

test("a pending old consumer cannot use or delete a replacement approval", async (t) => {
  const { effect, run, race } = fixture(t);
  run("grant");
  const [old] = await race(["purge-history"], "held-consume", () => {
    run("grant", "vault-migrate");
  });
  assert.equal(old.ok, false);
  assert.equal(readFileSync(effect, "utf8"), "");
  assert.equal(run("consume", "vault-migrate").ok, true);
  assert.equal(readFileSync(effect, "utf8"), "effect\n");
});

test("one broad approval permits one actual effect across competing processes and scopes", async (t) => {
  const { project, effect, run, race } = fixture(t);
  run("grant", "all");
  const results = await race(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? "vault-migrate" : "purge-history")),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(readFileSync(effect, "utf8"), "effect\n");
  const audit = readFileSync(join(project, ".kit-audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    audit.filter((entry) => entry.operation === "elevation-check" && entry.success).length,
    1,
  );
});

test("explicit revocation prevents restoration, and new approval supersedes the saved grant", (t) => {
  const { project, effect, run } = fixture(t);
  run("grant");
  const marker = join(project, ".kit", "elevation.json");
  const saved = readFileSync(marker);
  run("revoke");
  writeFileSync(marker, saved);
  assert.equal(run("consume").ok, false);
  run("grant", "vault-migrate");
  const replacement = readFileSync(marker);
  writeFileSync(marker, saved);
  assert.equal(run("consume").ok, false);
  assert.equal(readFileSync(effect, "utf8"), "");
  writeFileSync(marker, replacement);
  assert.equal(run("consume", "vault-migrate").ok, true);
});

test("fresh human approval permits another effect within the same process", (t) => {
  const { effect, run } = fixture(t);
  run("grant");
  assert.deepEqual(
    run("fresh-reuse").results?.map((value) => value.ok),
    [true, true],
  );
  assert.equal(readFileSync(effect, "utf8"), "effect\neffect\n");
});

test("simultaneous CI bypass requests authorize one effect and preserve a separate human grant", (t) => {
  const { effect, run } = fixture(t);
  run("grant");
  assert.equal(run("ci-race").results?.filter((result) => result.ok).length, 1);
  assert.equal(readFileSync(effect, "utf8"), "effect\n");
  assert.equal(run("consume").ok, true);
  assert.equal(readFileSync(effect, "utf8"), "effect\neffect\n");
});

test("missing authority refuses saved permission without recreating it during inspection", (t) => {
  const { home, effect, run } = fixture(t);
  run("grant");
  const directory = join(home, ".kit", "elevation-authority");
  rmSync(directory, { recursive: true });
  assert.equal(run("inspect").ok, false);
  assert.equal(existsSync(directory), false);
  assert.equal(run("consume").ok, false);
  assert.equal(readFileSync(effect, "utf8"), "");
  run("grant");
  assert.equal(run("consume").ok, true);
});

test("a failed audit refuses effects and leaves the reserved approval consumed", (t) => {
  const { project, effect, run } = fixture(t);
  run("grant");
  const marker = join(project, ".kit", "elevation.json");
  const saved = readFileSync(marker);
  const audit = join(project, ".kit-audit.jsonl");
  mkdirSync(audit);
  assert.equal(run("consume").ok, false);
  assert.equal(readFileSync(effect, "utf8"), "");
  rmSync(audit, { recursive: true });
  writeFileSync(marker, saved);
  assert.equal(run("consume").ok, false);
  run("grant");
  assert.equal(run("consume").ok, true);
  assert.equal(readFileSync(effect, "utf8"), "effect\n");
});

test("corrupt authority refuses access without replacing its bytes", (t) => {
  const { home, effect, run } = fixture(t);
  run("grant");
  const authority = join(home, ".kit", "elevation-authority", "grants.sqlite");
  const corrupt = "not an authority database\n";
  writeFileSync(authority, corrupt);
  assert.equal(run("inspect").ok, false);
  assert.equal(run("consume").ok, false);
  assert.equal(readFileSync(authority, "utf8"), corrupt);
  assert.equal(readFileSync(effect, "utf8"), "");
});
