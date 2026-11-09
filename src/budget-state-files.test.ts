import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { checkBudgetLimits, clearBudgetState, getBudgetStatus, recordUsage } from "./budget.js";

const config = { enabled: true };
const stateError = "Could not read budget usage. Check .kit-budget.json.";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "kit-budget-state-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  return { cwd, path: join(cwd, ".kit-budget.json"), outside: join(root, "outside") };
}

async function assertRefused(cwd: string) {
  await assert.rejects(getBudgetStatus(config, { cwd }), { message: stateError });
  assert.deepEqual(await checkBudgetLimits(config, 0, { cwd }), {
    allowed: false,
    reason: stateError,
  });
  await assert.rejects(recordUsage(config, 1, { cwd }), { message: stateError });
}

for (const broken of [false, true]) {
  it(`budget APIs refuse ${broken ? "broken" : "existing"} state symlinks and clear only the link`, async (t) => {
    const { cwd, path, outside } = await fixture(t);
    const content = JSON.stringify({
      tokens_today: 7,
      operations_this_hour: 1,
      last_token_reset: new Date().toISOString(),
      last_operation_reset: new Date().toISOString(),
    });
    if (!broken) await writeFile(outside, content);
    await symlink(outside, path);
    await assertRefused(cwd);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    if (!broken) assert.equal(await readFile(outside, "utf8"), content);
    else await assert.rejects(lstat(outside), { code: "ENOENT" });
    await clearBudgetState({ cwd });
    await assert.rejects(lstat(path), { code: "ENOENT" });
    await recordUsage(config, 2, { cwd });
    assert.equal((await getBudgetStatus(config, { cwd })).tokens_used, 2);
    if (!broken) assert.equal(await readFile(outside, "utf8"), content);
    else await assert.rejects(lstat(outside), { code: "ENOENT" });
  });
}

it("budget APIs refuse a directory at the state path without changing it", async (t) => {
  const { cwd, path } = await fixture(t);
  await mkdir(path);
  await assertRefused(cwd);
  assert.equal((await lstat(path)).isDirectory(), true);
});

it("budget APIs refuse hard links so usage cannot overwrite another project's state", async (t) => {
  const { cwd, path, outside } = await fixture(t);
  const content = JSON.stringify({
    tokens_today: 7,
    operations_this_hour: 1,
    last_token_reset: new Date().toISOString(),
    last_operation_reset: new Date().toISOString(),
  });
  await writeFile(outside, content);
  await link(outside, path);
  await assertRefused(cwd);
  await clearBudgetState({ cwd });
  await recordUsage(config, 2, { cwd });
  assert.equal(await readFile(outside, "utf8"), content);
});

it("budget APIs refuse state read permission errors without changing bytes", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("This check needs POSIX permissions and a non-root user.");
    return;
  }
  const { cwd, path } = await fixture(t);
  await recordUsage(config, 7, { cwd });
  const before = await readFile(path, "utf8");
  await chmod(path, 0);
  try {
    await assertRefused(cwd);
  } finally {
    await chmod(path, 0o600);
  }
  assert.equal(await readFile(path, "utf8"), before);
});

it("usage reports a sanitized save failure when the state is not writable", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("This check needs POSIX permissions and a non-root user.");
    return;
  }
  const { cwd, path } = await fixture(t);
  await recordUsage(config, 7, { cwd });
  const before = await readFile(path, "utf8");
  await chmod(path, 0o400);
  try {
    await assert.rejects(recordUsage(config, 1, { cwd }), {
      message: "Could not save budget usage. Check .kit-budget.json.",
    });
  } finally {
    await chmod(path, 0o600);
  }
  assert.equal(await readFile(path, "utf8"), before);
});
