import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { getBudgetStatus, recordUsage } from "./budget.js";

it("keeps the previous complete budget when replacement fails", async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "kit-budget-atomic-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const config = { enabled: true };
  await recordUsage(config, 4, { cwd });
  const before = await fs.readFile(join(cwd, ".kit-budget.json"), "utf8");
  const replace = t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("fixture replacement failure"), { code: "EIO" });
  });
  await assert.rejects(recordUsage(config, 7, { cwd }), /Could not save budget usage/);
  replace.mock.restore();
  assert.equal(await fs.readFile(join(cwd, ".kit-budget.json"), "utf8"), before);
  assert.deepEqual(await getBudgetStatus(config, { cwd }), {
    tokens_used: 4,
    tokens_limit: 1000000,
    operations_used: 1,
    operations_limit: 100,
  });
  assert.deepEqual((await fs.readdir(cwd)).sort(), [".kit-budget-lock.sqlite", ".kit-budget.json"]);
});

// Windows refuses to replace a file while a reader holds it open. The writer waits for the
// reader there, and this reader waits for the writer, so the scenario cannot occur.
const snapshotSkip =
  process.platform === "win32" ? "Windows cannot replace a ledger that a reader holds open" : false;

it(
  "reads a complete snapshot when a writer replaces an already opened ledger",
  {
    skip: snapshotSkip,
  },
  async (t) => {
    const { syncBuiltinESMExports } = await import("node:module");
    const { constants } = await import("node:fs");
    const cwd = await fs.mkdtemp(join(tmpdir(), "kit-budget-snapshot-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const config = { enabled: true };
    await recordUsage(config, 4, { cwd });
    const originalOpen = fs.open;
    let replaced = false;
    const probe = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const [path, flags] = args;
      const file = await originalOpen(...args);
      if (
        !replaced &&
        path === join(cwd, ".kit-budget.json") &&
        typeof flags === "number" &&
        !(flags & (constants.O_WRONLY | constants.O_RDWR))
      ) {
        replaced = true;
        try {
          await recordUsage(config, 1, { cwd });
        } catch (error) {
          await file.close();
          throw error;
        }
      }
      return file;
    });
    syncBuiltinESMExports();
    try {
      const snapshot = await getBudgetStatus(config, { cwd });
      assert.equal(replaced, true);
      assert.equal(snapshot.tokens_used, 4);
      assert.equal(snapshot.operations_used, 1);
    } finally {
      probe.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await getBudgetStatus(config, { cwd })).tokens_used, 5);
  },
);
