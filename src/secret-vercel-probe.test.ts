import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { CLI_PATH, outsideAgentSession } from "./cli-run.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const fixtureToken = "synthetic-z10-credential";

it("distinguishes missing, unreadable, rejected and unverified tokens through kit check", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kit-vercel-probe-"));
  t.after(() => rmTemp(cwd));
  writeFileSync(
    join(cwd, ".kit.toml"),
    'version = 1\n[secrets.keys.VERCEL_TOKEN]\nsource = "env"\n',
  );
  const preload = join(cwd, "fixture.mjs");
  writeFileSync(
    preload,
    `
globalThis.fetch = async (url, options) => {
  if (url !== "https://api.vercel.com/v2/user" || options.redirect !== "error" ||
      options.headers.Authorization !== "Bearer " + process.env.VERCEL_TOKEN) {
    throw new Error("Wrong probe");
  }
  process.stderr.write("fixture probe ran\\n");
  if (process.env.FIXTURE_STATUS === "error") throw new Error(process.env.VERCEL_TOKEN);
  return new Response(null, { status: Number(process.env.FIXTURE_STATUS) });
};`,
  );
  function run(value: string | undefined, status: string, verify = true, offline = false) {
    const env = outsideAgentSession();
    delete env.VERCEL_TOKEN;
    if (value !== undefined) env.VERCEL_TOKEN = value;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        CLI_PATH,
        "check",
        ...(verify ? ["verify-vercel-token"] : ["--category", "secrets"]),
        "--json",
      ],
      {
        cwd,
        env: { ...env, KIT_AIRGAP: offline ? "1" : "0", FIXTURE_STATUS: status },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.ifError(child.error);
    assert.ok(!(child.stdout + child.stderr).includes(fixtureToken));
    const output = JSON.parse(child.stdout);
    const [row] = output.checks;
    return { exit: child.status, row, probed: child.stderr.includes("fixture probe ran") };
  }

  const absent = run(undefined, "200");
  assert.equal(absent.row.secretState, "missing");
  assert.equal(absent.probed, false);
  const empty = run("", "200");
  assert.equal(empty.row.secretState, "unreadable");
  assert.equal(empty.exit, 1);
  assert.equal(empty.probed, false);
  const accepted = run(fixtureToken, "200");
  assert.equal(accepted.row.status, "pass");
  assert.equal(accepted.probed, true);
  const refused = run(fixtureToken, "403");
  assert.equal(refused.row.secretState, "invalid");
  assert.equal(refused.row.status, "fail");
  assert.equal(refused.exit, 1);
  for (const unresolved of [
    run(fixtureToken, "429"),
    run(fixtureToken, "error"),
    run(fixtureToken, "200", true, true),
  ]) {
    assert.equal(unresolved.row.status, "warn");
    assert.equal(unresolved.row.didNotRun, true);
    assert.equal(unresolved.row.secretState, undefined);
    assert.equal(unresolved.exit, 1);
  }
  assert.equal(run(fixtureToken, "200", true, true).probed, false);
  const ordinary = run(fixtureToken, "403", false);
  assert.equal(ordinary.probed, false);
  assert.equal(ordinary.row.status, "pass");
});
