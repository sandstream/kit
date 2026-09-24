import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const sourceTest = import.meta.url.endsWith(".ts");
const cli = fileURLToPath(new URL(sourceTest ? "../cli.ts" : "../cli.js", import.meta.url));

function run(cwd: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [...(sourceTest ? ["--import", import.meta.resolve("tsx")] : []), cli, ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_NON_INTERACTIVE: "1" },
    },
  );
}

it("policy init never writes through a dangling policy symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-policy-init-exclusive-"));
  try {
    const policy = join(root, ".kit-policy.toml");
    const target = join(root, "unrelated");
    symlinkSync("unrelated", policy);
    const result = run(root, "policy", "init");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(lstatSync(policy).isSymbolicLink(), true);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("policy init --force replaces the link rather than its target", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-policy-force-exclusive-"));
  try {
    const policy = join(root, ".kit-policy.toml");
    const target = join(root, "unrelated");
    writeFileSync(target, "leave alone\n");
    symlinkSync("unrelated", policy);
    const result = run(root, "policy", "init", "--force");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(lstatSync(policy).isFile(), true);
    assert.equal(readFileSync(target, "utf8"), "leave alone\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("sentinel install never writes through a dangling workflow symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-sentinel-exclusive-"));
  try {
    const workflow = join(root, ".github", "workflows", "kit-sentinel.yml");
    mkdirSync(dirname(workflow), { recursive: true });
    symlinkSync("unrelated", workflow);
    const result = run(root, "sentinel", "install");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(lstatSync(workflow).isSymbolicLink(), true);
    assert.equal(existsSync(join(dirname(workflow), "unrelated")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("sentinel install --force replaces the link rather than its target", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-sentinel-force-exclusive-"));
  try {
    const workflow = join(root, ".github", "workflows", "kit-sentinel.yml");
    mkdirSync(dirname(workflow), { recursive: true });
    const target = join(dirname(workflow), "unrelated");
    writeFileSync(target, "leave alone\n");
    symlinkSync("unrelated", workflow);
    const result = run(root, "sentinel", "install", "--force");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(lstatSync(workflow).isFile(), true);
    assert.equal(readFileSync(target, "utf8"), "leave alone\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
