import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { it } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";

const dist = join(process.cwd(), "dist");
const cli = join(dist, "cli.js");
const fixture = join(dist, "review-receipt-process.test-support.js");

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
}

function runGit(args: string[], cwd: string): string {
  const result = run("git", args, cwd, process.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeFakeGh(bin: string): string {
  const mock = join(bin, "mock-gh.cjs");
  writeFileSync(
    mock,
    `const path = require('node:path');\n` +
      `const fake = path.basename(process.execPath).toLowerCase() === 'gh.exe' || path.basename(process.argv[1] || '') === 'gh';\n` +
      `if (fake) {\n` +
      ` const args = process.argv.slice(path.basename(process.execPath).toLowerCase() === 'gh.exe' ? 1 : 2);\n` +
      ` const h = process.env.KIT_TEST_REMOTE_HEAD; let result;\n` +
      ` if (args[0] === 'repo') result = {nameWithOwner:'sandstream/kit'};\n` +
      ` else if (args[0] === 'pr') result = {number:12,headRefOid:h,changedFiles:0,files:[],statusCheckRollup:[]};\n` +
      ` else if (args.includes('graphql')) result = {data:{repository:{defaultBranchRef:{name:'main',target:{oid:h}},pullRequest:{number:12,headRefOid:h,baseRefName:'main',baseRef:{target:{oid:h}}}}}};\n` +
      ` else throw Error('Unexpected gh invocation');\n` +
      ` process.stdout.write(JSON.stringify(result)); process.exit(0);\n` +
      `}\n`,
  );
  if (process.platform === "win32") copyFileSync(process.execPath, join(bin, "gh.exe"));
  else
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\nrequire(${JSON.stringify(mock)});\n`, {
      mode: 0o700,
    });
  return mock;
}

function environment(home: string, bin: string, anchor: string, head: string): NodeJS.ProcessEnv {
  const mock = makeFakeGh(bin);
  return {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TMP: home,
    TEMP: home,
    TMPDIR: home,
    NODE_OPTIONS: `--require=${JSON.stringify(mock)}`,
    KIT_AUDIT_ANCHOR_DIR: anchor,
    KIT_AUDIT_ANCHOR: "0",
    KIT_NON_INTERACTIVE: "1",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_TEST_REMOTE_HEAD: head,
  };
}

async function waitFor(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("fixture exited early");
    if (Date.now() > deadline) throw new Error("fixture did not become ready");
    await new Promise((done) => setTimeout(done, 30));
  }
}

async function interruptedReview(root: string, signals: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [fixture, root, "crash", signals], {
    env,
    stdio: "ignore",
  });
  try {
    await waitFor(join(signals, "crash.ready"), child);
    child.kill("SIGKILL");
    await new Promise<void>((done) => child.once("exit", () => done()));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

it("recovers after a read-only refusal without ignoring or changing its audit log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-audit-cli-"));
  const root = join(dir, "repo");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const signals = join(dir, "signals");
  try {
    for (const path of [root, home, bin, signals]) mkdirSync(path);
    runGit(["init", "-q"], root);
    runGit(["config", "core.hooksPath", join(dir, "no-hooks")], root);
    writeFileSync(join(root, ".kit.toml"), "");
    runGit(["add", ".kit.toml"], root);
    runGit(
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "fixture",
      ],
      root,
    );
    const head = runGit(["rev-parse", "HEAD"], root);
    const env = environment(home, bin, join(dir, "anchor"), head);
    await interruptedReview(root, signals, env);
    const args = [cli, "review", "recover-receipt", "--confirm-stopped"];
    const denied = run(process.execPath, args, root, { ...env, KIT_READ_ONLY: "1" });
    assert.notEqual(denied.status, 0);
    assert.match(`${denied.stdout}\n${denied.stderr}`, /read.only|read only/i);
    const audit = join(root, ".kit-audit.jsonl");
    const before = readFileSync(audit, "utf8");
    assert.match(before, /review-recover-receipt/);
    const unresolved = run(process.execPath, args, root, env);
    assert.notEqual(unresolved.status, 0);
    assert.match(unresolved.stderr, /Review result is unknown/);
    const recovered = run(
      process.execPath,
      [
        ...args,
        "--acknowledge-unknown",
        "--interruption-review",
        "Human inspected the available review output.",
      ],
      root,
      env,
    );
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.match(recovered.stdout, /Unknown review result and human assessment recorded/);
    assert.equal(readFileSync(audit, "utf8"), before);
    const receipt = JSON.parse(readFileSync(join(root, ".kit-review-receipt.json"), "utf8")) as {
      run_status: string;
    };
    assert.equal(receipt.run_status, "interrupted");
    const verify = run(process.execPath, [cli, "review", "verify-receipt"], root, env);
    assert.notEqual(verify.status, 0);
    assert.match(`${verify.stdout}\n${verify.stderr}`, /review was interrupted/i);
  } finally {
    rmTemp(dir);
  }
});

it("assesses an older interruption through the real CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-resolve-cli-"));
  const root = join(dir, "repo"),
    home = join(dir, "home"),
    bin = join(dir, "bin"),
    signals = join(dir, "signals");
  try {
    for (const path of [root, home, bin, signals]) mkdirSync(path);
    runGit(["init", "-q"], root);
    writeFileSync(join(root, ".kit.toml"), "");
    runGit(["add", ".kit.toml"], root);
    runGit(
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "fixture",
      ],
      root,
    );
    const env = environment(home, bin, join(dir, "anchor"), runGit(["rev-parse", "HEAD"], root));
    const seeded = run(process.execPath, [fixture, root, "legacy-interrupted", signals], root, env);
    assert.equal(seeded.status, 0, seeded.stderr);
    const history = join(root, ".kit-review-receipt-history.jsonl");
    const original = JSON.parse(readFileSync(history, "utf8")) as { run_id: string; head: string };
    const flags = [
      "--acknowledge-unknown",
      "--interruption-review",
      "Inspected logs and accepted the remaining unknown risk.",
    ];
    const wrong = run(
      process.execPath,
      [cli, "review", "resolve-interruption", "a".repeat(32), ...flags],
      root,
      env,
    );
    assert.notEqual(wrong.status, 0);
    assert.equal(existsSync(join(root, ".git", "kit-review-receipt.lock")), false);
    const result = run(
      process.execPath,
      [cli, "review", "resolve-interruption", original.run_id, ...flags],
      root,
      env,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(original.run_id));
    assert.ok(result.stdout.includes(original.head));
    const records = readFileSync(history, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[1].resolves_run_id, original.run_id);
    assert.equal(records[1].interruption_disposition, "risk-accepted");
  } finally {
    rmTemp(dir);
  }
});
