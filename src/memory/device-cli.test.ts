import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PendingAction } from "./pal.js";

const exec = promisify(execFile);

it("simultaneous fresh CLI sessions share pending work and claim ownership", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kit-device-cli-")));
  const root = join(tmp, "repo");
  const store = join(tmp, "store");
  mkdirSync(root);
  const source = import.meta.url.endsWith(".ts");
  const runner = [
    ...(source ? ["--import", import.meta.resolve("tsx")] : []),
    fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url)),
  ];
  const env = {
    ...process.env,
    KIT_MEMORY_DIR: store,
    KIT_MEMORY_DB: join(store, "memory.db"),
    KIT_DEVICE_ID: "",
    KIT_IDENTITY_DIR: join(tmp, "identity"),
    KIT_CLAUDE_DIR: join(tmp, "claude"),
    KIT_CODEX_DIR: join(tmp, "codex"),
    KIT_NO_UPDATE_CHECK: "1",
    KIT_AUDIT_ANCHOR: "0",
    KIT_NON_INTERACTIVE: "1",
  };
  const cli = async (...args: string[]) => {
    const result = await exec(process.execPath, [...runner, "memory", "pal", ...args], {
      cwd: root,
      env,
      timeout: 30_000,
    });
    return result.stdout;
  };
  const list = async (status = "open"): Promise<PendingAction[]> =>
    JSON.parse(await cli("list", "--json", `--status=${status}`));
  try {
    await exec("git", ["init", "-q", root]);
    const titles = ["Claude pending work", "Codex pending work"];
    const started = await Promise.allSettled(titles.map((title) => cli("add", title)));
    // Wait for both processes to exit before checking or removing their shared fixture.
    for (const result of started) {
      assert.equal(
        result.status,
        "fulfilled",
        result.status === "rejected" ? String(result.reason) : "",
      );
    }
    const actions = await list();
    assert.deepEqual(actions.map((action) => action.title).sort(), titles);
    const origin = readFileSync(join(store, "device-id"), "utf8").trim();
    assert.match(origin, /^[a-f0-9]{16}$/);
    assert.ok(actions.every((action) => action.origin_device === origin));
    const ownerArgs = ["--harness", "claude-code", "--session", "fresh-session"];
    const before = JSON.parse(await cli("show", actions[0].id, "--json"));
    const receipt = JSON.parse(
      await cli("claim", actions[0].id, ...ownerArgs, "--expect", before.frontier, "--json"),
    );
    assert.equal(receipt.status, "applied");
    const claimed = (await list("claimed")).find((action) => action.id === actions[0].id);
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.claimed_by, "claude-code");
    assert.deepEqual(claimed?.claim_owner, {
      device: origin,
      harness: "claude-code",
      session: "fresh-session",
    });
    await cli("release", actions[0].id, ...ownerArgs, "--expect", receipt.view.frontier);
    assert.equal((await list()).find((action) => action.id === actions[0].id)?.status, "open");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
